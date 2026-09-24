'use server'

import { randomUUID } from 'node:crypto'
import type { Json } from '@dr/db/types'
import { type TldPricing, userMessageFor } from '@dr/shared'
import { z } from 'zod'
import { checkoutOpenTo } from '@/features/checkout/lib/access'
import { defaultRegistrant } from '@/features/checkout/queries/registrant'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import {
  BULK_RENEW_MAX,
  bulkRenewalTotals,
  paymentCustomer,
  renewability,
  renewalCostUsd,
  sharedRegistrant,
} from '../lib/renewal'
import { guardBulkRenewal } from '../queries/renewal-guard'
import { checkFloat, startRenewalPayment } from '../queries/renewal-order'

/**
 * Renews several domains for the same years in one order, paid once (PRD
 * FR-P4, FR-P5, FR-RN1). Every rule of the one-domain renewal
 * (`placeRenewal`) applies to each domain — the account's own, renewable
 * now, on the payment's side, not already being renewed, the years within
 * what it can take — and the whole order is refused, charging nothing, if
 * any one fails. Each line is priced as the one-domain renewal prices it,
 * the total must be the one shown (FR-C4), and the float must cover them
 * all (I3). Payment queues one renewal job per line (migration 23).
 */

type Result = { error: string } | { redirectTo: string }

const NOT_CHARGED = "You haven't been charged."

const dbError = (error: { code?: string; message: string } | null) => ({
  code: error?.code,
  err: error?.message,
})

export const placeRenewals = authAction
  .inputSchema(
    z.object({
      domainIds: z.array(z.uuid()).min(1).max(BULK_RENEW_MAX),
      years: z.number().int().min(1).max(10),
      // The total the customer saw. If it moved, they see the new one first.
      expectedTotalKobo: z.number().int().positive(),
    }),
  )
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
    const refused = await guardBulkRenewal(ctx)
    if (refused) return refused
    if (!checkoutOpenTo(ctx.user.email, env.CHECKOUT_ALLOWLIST)) {
      return { error: `Payments aren't open yet. ${NOT_CHARGED}` }
    }
    // SEC-11: the same limits as checkout — each attempt opens a payment.
    const [recent, today] = await Promise.all([
      withinLimit(`place_order:${ctx.user.id}`, LIMITS.placeOrder),
      withinLimit(`place_order_day:${ctx.user.id}`, LIMITS.placeOrderDaily),
    ])
    if (!recent || !today) {
      logger.warn({ userId: ctx.user.id }, 'renewal rate limit reached')
      return { error: `Too many attempts. ${NOT_CHARGED} Wait a few minutes, then try again.` }
    }
    const payment = requirePaymentEnv()
    const ids = [...new Set(parsedInput.domainIds)]

    // ── The domains, as the customer (RLS): theirs, or nothing ───────────
    const { data: domains, error: domainsError } = await ctx.supabase
      .from('domains')
      .select(
        'id, domain_name, tld, source, test_mode, local_status, expires_at, auto_renew, privacy_enabled, registrant',
      )
      .in('id', ids)
    if (domainsError) {
      logger.error(dbError(domainsError), 'renewal domains could not be read')
      return { error: `We couldn't complete this just now. ${NOT_CHARGED} Try again shortly.` }
    }
    if ((domains ?? []).length !== ids.length) {
      return {
        error: `Some of those domains aren't on your account. ${NOT_CHARGED} Go back to your domains and choose again.`,
      }
    }
    const ordered = [...(domains ?? [])].sort((a, b) => a.domain_name.localeCompare(b.domain_name))

    // A second renewal while one is being made is refused — read failures too.
    const { data: open, error: openError } = await ctx.supabase
      .from('order_items')
      .select('domain_id, status, orders!inner(status)')
      .in('domain_id', ids)
      .eq('item_type', 'renew')
      .in('status', ['pending', 'provisioning'])
      .in('orders.status', ['paid', 'provisioning'])
    if (openError) {
      logger.error(dbError(openError), 'open renewals could not be read')
      return { error: `We couldn't complete this just now. ${NOT_CHARGED} Try again shortly.` }
    }
    const inProgress = new Set((open ?? []).map((line) => line.domain_id))

    const priced = await getPricedCatalogue()
    if (!priced) {
      return {
        error: `Renewal prices are unavailable right now. ${NOT_CHARGED} Try again shortly.`,
      }
    }

    // ── Each domain by the one-domain rules ──────────────────────────────
    const now = new Date()
    const pricings: TldPricing[] = []
    for (const domain of ordered) {
      const pricing = priced.tlds.find((tld) => tld.tld === domain.tld)
      if (!pricing) {
        return {
          error: `${domain.domain_name}: renewal prices for .${domain.tld} are unavailable right now. ${NOT_CHARGED}`,
        }
      }
      const check = renewability(
        {
          source: domain.source as 'registration' | 'transfer' | 'demo',
          status: domain.local_status as Parameters<typeof renewability>[0]['status'],
          testMode: domain.test_mode,
          expiresAt: domain.expires_at,
        },
        {
          paymentTestMode: payment.testMode,
          tldMaxPeriod: pricing.maxPeriod,
          inProgress: inProgress.has(domain.id),
          now,
        },
      )
      if (!check.ok) return { error: `${domain.domain_name}: ${check.reason} ${NOT_CHARGED}` }
      if (parsedInput.years > check.maxYears) {
        return {
          error: `${domain.domain_name} can be renewed for at most ${check.maxYears} ${check.maxYears === 1 ? 'year' : 'years'} now. ${NOT_CHARGED}`,
        }
      }
      pricings.push(pricing)
    }

    // ── Price re-validation (FR-C4) ──────────────────────────────────────
    const totals = bulkRenewalTotals(pricings, parsedInput.years, priced.vatPct)
    if (totals.totalKobo !== parsedInput.expectedTotalKobo) {
      return {
        error: `The renewal price has changed since this page loaded. ${NOT_CHARGED} Check the new total, then pay.`,
      }
    }

    // ── Float pre-flight (FR-C8, I3) ─────────────────────────────────────
    const service = createServiceClient()
    const tlds = [...new Set(ordered.map((domain) => domain.tld))]
    const [{ data: costs }, { data: settings }, { data: rate }] = await Promise.all([
      service.from('tlds').select('name, renew_usd, is_country_code').in('name', tlds),
      service.from('pricing_settings').select('icann_fee_usd').maybeSingle(),
      service.from('fx_rates').select('id').eq('status', 'active').maybeSingle(),
    ])
    const costOf = new Map((costs ?? []).map((cost) => [cost.name, cost]))
    if (!rate || tlds.some((tld) => !costOf.has(tld))) {
      logger.error({ tlds, rate: Boolean(rate) }, 'bulk renewal cannot be costed')
      return {
        error: `Renewal prices are unavailable right now. ${NOT_CHARGED} Try again shortly.`,
      }
    }
    const icannFeeUsd = Number(settings?.icann_fee_usd ?? 0)
    const costUsd = ordered.reduce((sum, domain) => {
      const cost = costOf.get(domain.tld)
      return (
        sum +
        renewalCostUsd(
          { renewUsd: Number(cost?.renew_usd), isCountryCode: Boolean(cost?.is_country_code) },
          parsedInput.years,
          icannFeeUsd,
        )
      )
    }, 0)
    const float = await checkFloat(Math.round(costUsd * 100) / 100, payment.testMode)
    if (!float.ok) {
      return float.reason === 'insufficient'
        ? { error: userMessageFor('SUPPLIER_INSUFFICIENT_FUNDS') }
        : {
            error: `We couldn't complete this just now. ${NOT_CHARGED} Try again in a few minutes.`,
          }
    }

    // ── The order, and a line per domain ─────────────────────────────────
    // The receipt's customer: the domains' registrant when they share one,
    // else the account's own details — never one client's name on another's.
    const registrant =
      sharedRegistrant(ordered.map((domain) => domain.registrant)) ??
      (await defaultRegistrant(ctx.supabase, ctx.user))
    // `MDH-` routes Flutterwave's notices here through Paidly (see placeOrder).
    const txRef = `MDH-${randomUUID()}`
    const { data: order, error: orderError } = await service
      .from('orders')
      .insert({
        user_id: ctx.user.id,
        subtotal_kobo: totals.subtotalKobo,
        vat_pct: priced.vatPct,
        vat_kobo: totals.vatKobo,
        total_kobo: totals.totalKobo,
        fx_rate_id: rate.id,
        tx_ref: txRef,
        registrant: registrant as Json,
        float_check: float.shortfall ? 'shortfall_test_mode' : 'covered',
        test_mode: payment.testMode,
      })
      .select('id, order_number')
      .single()
    if (orderError || !order) {
      logger.error(dbError(orderError), 'bulk renewal order insert failed')
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    const { error: lineError } = await service.from('order_items').insert(
      ordered.map((domain, index) => ({
        order_id: order.id,
        item_type: 'renew' as const,
        domain_id: domain.id,
        domain: domain.domain_name,
        tld: domain.tld,
        period_years: parsedInput.years,
        privacy: domain.privacy_enabled,
        auto_renew: domain.auto_renew,
        price_kobo: totals.lineKobo[index] ?? 0,
        renewal_kobo: pricings[index]?.renewal.priceKobo ?? 0,
      })),
    )
    if (lineError) {
      logger.error({ ...dbError(lineError), orderId: order.id }, 'bulk renewal lines insert failed')
      await service.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    // ── Hand over to Flutterwave ─────────────────────────────────────────
    return startRenewalPayment(service, order, {
      txRef,
      totalKobo: totals.totalKobo,
      customer: paymentCustomer(registrant as Record<string, string | undefined>, ctx.user.email),
    })
  })
