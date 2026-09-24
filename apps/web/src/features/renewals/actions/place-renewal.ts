'use server'

import { randomUUID } from 'node:crypto'
import { accountBalanceSchema, renewalTotalKobo, userMessageFor, vatKobo } from '@dr/shared'
import { z } from 'zod'
import { checkoutOpenTo } from '@/features/checkout/lib/access'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { renewability, renewalCostUsd } from '../lib/renewal'

/**
 * Renews a domain for the years chosen (PRD FR-RN1, FR-RN5): an order with
 * one renewal line, paid on Flutterwave's page. Every check that can stop it
 * runs before any money moves — the domain is the customer's and renewable,
 * the price is the one they saw, and the supplier float covers it (I3). The
 * renewal itself is queued when the payment is confirmed, and made by the
 * gateway, which reads the registry before and after (I2).
 */

type Result = { error: string } | { redirectTo: string }

const NOT_CHARGED = "You haven't been charged."

const dbError = (error: { code?: string; message: string } | null) => ({
  code: error?.code,
  err: error?.message,
})

export const placeRenewal = authAction
  .inputSchema(
    z.object({
      domainId: z.uuid(),
      years: z.number().int().min(1).max(10),
      // The total the customer saw. If it moved, they see the new one first.
      expectedTotalKobo: z.number().int().positive(),
    }),
  )
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
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

    // ── The domain, as the customer (RLS): theirs, or nothing ────────────
    const { data: domain } = await ctx.supabase
      .from('domains')
      .select(
        'id, domain_name, tld, source, test_mode, local_status, expires_at, auto_renew, privacy_enabled, registrant',
      )
      .eq('id', parsedInput.domainId)
      .maybeSingle()
    if (!domain) return { error: `We couldn't find that domain on your account. ${NOT_CHARGED}` }

    // A second renewal while one is being made is refused — read failures too.
    const { data: open, error: openError } = await ctx.supabase
      .from('order_items')
      .select('status, orders!inner(status)')
      .eq('domain_id', domain.id)
      .eq('item_type', 'renew')
      .in('status', ['pending', 'provisioning'])
      .in('orders.status', ['paid', 'provisioning'])
      .limit(1)
    if (openError) {
      logger.error(dbError(openError), 'open renewals could not be read')
      return { error: `We couldn't complete this just now. ${NOT_CHARGED} Try again shortly.` }
    }

    const priced = await getPricedCatalogue()
    const pricing = priced?.tlds.find((tld) => tld.tld === domain.tld)
    if (!priced || !pricing) {
      return {
        error: `Renewal prices are unavailable right now. ${NOT_CHARGED} Try again shortly.`,
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
        inProgress: (open ?? []).length > 0,
        now: new Date(),
      },
    )
    if (!check.ok) return { error: `${check.reason} ${NOT_CHARGED}` }
    if (parsedInput.years > check.maxYears) {
      return {
        error: `This domain can be renewed for at most ${check.maxYears} ${check.maxYears === 1 ? 'year' : 'years'} now. ${NOT_CHARGED}`,
      }
    }

    // ── Price re-validation (FR-C4) ──────────────────────────────────────
    const subtotal = renewalTotalKobo(pricing, parsedInput.years)
    const vat = vatKobo(subtotal, priced.vatPct)
    const total = subtotal + vat
    if (total !== parsedInput.expectedTotalKobo) {
      return {
        error: `The renewal price has changed since this page loaded. ${NOT_CHARGED} Check the new total, then pay.`,
      }
    }

    // ── Float pre-flight (FR-C8, I3) ─────────────────────────────────────
    const service = createServiceClient()
    const [{ data: cost }, { data: settings }, { data: rate }] = await Promise.all([
      service
        .from('tlds')
        .select('renew_usd, is_country_code')
        .eq('name', domain.tld)
        .maybeSingle(),
      service.from('pricing_settings').select('icann_fee_usd').maybeSingle(),
      service.from('fx_rates').select('id').eq('status', 'active').maybeSingle(),
    ])
    if (!cost || !rate) {
      logger.error({ tld: domain.tld, rate: Boolean(rate) }, 'renewal cannot be costed')
      return {
        error: `Renewal prices are unavailable right now. ${NOT_CHARGED} Try again shortly.`,
      }
    }
    const costUsd = renewalCostUsd(
      { renewUsd: Number(cost.renew_usd), isCountryCode: Boolean(cost.is_country_code) },
      parsedInput.years,
      Number(settings?.icann_fee_usd ?? 0),
    )
    let balanceUsd: number
    try {
      balanceUsd = accountBalanceSchema.parse(
        await callGateway<unknown>({
          path: 'account/balance',
          signal: AbortSignal.timeout(15_000),
        }),
      ).balanceUsd
    } catch (err) {
      logger.error({ err }, 'renewal float pre-flight failed')
      return {
        error: `We couldn't complete this just now. ${NOT_CHARGED} Try again in a few minutes.`,
      }
    }
    const shortfall = balanceUsd < costUsd
    if (shortfall && !payment.testMode) {
      logger.error({ costUsd, balanceUsd }, 'OPS: supplier float too low to accept a renewal')
      return { error: userMessageFor('SUPPLIER_INSUFFICIENT_FUNDS') }
    }
    if (shortfall) {
      logger.warn({ costUsd, balanceUsd }, 'test mode: float shortfall recorded, renewal allowed')
    }

    // ── The order, and its one line ──────────────────────────────────────
    // `MDH-` routes Flutterwave's notices here through Paidly (see placeOrder).
    const txRef = `MDH-${randomUUID()}`
    const { data: order, error: orderError } = await service
      .from('orders')
      .insert({
        user_id: ctx.user.id,
        subtotal_kobo: subtotal,
        vat_pct: priced.vatPct,
        vat_kobo: vat,
        total_kobo: total,
        fx_rate_id: rate.id,
        tx_ref: txRef,
        registrant: domain.registrant ?? {},
        float_check: shortfall ? 'shortfall_test_mode' : 'covered',
        test_mode: payment.testMode,
      })
      .select('id, order_number')
      .single()
    if (orderError || !order) {
      logger.error(dbError(orderError), 'renewal order insert failed')
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    const { error: lineError } = await service.from('order_items').insert({
      order_id: order.id,
      item_type: 'renew',
      domain_id: domain.id,
      domain: domain.domain_name,
      tld: domain.tld,
      period_years: parsedInput.years,
      privacy: domain.privacy_enabled,
      auto_renew: domain.auto_renew,
      price_kobo: subtotal,
      renewal_kobo: pricing.renewal.priceKobo,
    })
    if (lineError) {
      logger.error({ ...dbError(lineError), orderId: order.id }, 'renewal line insert failed')
      await service.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    // ── Hand over to Flutterwave ─────────────────────────────────────────
    try {
      const registrant = (domain.registrant ?? {}) as Record<string, string | undefined>
      const redirectUrl = new URL('/app/checkout/complete', env.NEXT_PUBLIC_APP_URL)
      redirectUrl.searchParams.set('order', order.id)
      const name = [registrant.firstName, registrant.lastName].filter(Boolean).join(' ')
      const link = await createPaymentLink({
        txRef,
        amountKobo: total,
        redirectUrl: redirectUrl.toString(),
        customer: {
          email: ctx.user.email ?? registrant.email ?? '',
          name: name || (ctx.user.email ?? 'Customer'),
          ...(registrant.phone
            ? { phone: `+${registrant.phoneCountryCode ?? ''}${registrant.phone}` }
            : {}),
        },
        orderNumber: order.order_number,
      })
      return { redirectTo: link }
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'could not start renewal payment')
      await service.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
      return {
        error: `We couldn't reach our payment provider. ${NOT_CHARGED} Try again in a moment.`,
      }
    }
  })
