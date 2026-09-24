'use server'

import { randomUUID } from 'node:crypto'
import { accountBalanceSchema, userMessageFor } from '@dr/shared'
import { z } from 'zod'
import { getCartView } from '@/features/cart/queries/cart'
import { deleteLine, findCartId } from '@/features/cart/queries/store'
import { checkAvailability } from '@/features/search/queries/availability'
import { BUSINESS } from '@/lib/business'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { checkoutOpenTo } from '../lib/access'
import { registrantFormSchema, toContact } from '../lib/contact'
import { type SupplierCost, wholesaleCostUsd } from '../lib/cost'
import { lineHostsSchema } from '../lib/line-hosts'
import { chooseNameservers, planHosts } from '../queries/hosts'
import { saveDefaultContact } from '../queries/registrant'

/**
 * Places an order and hands the customer to Flutterwave (PRD §13.4 steps
 * 1–5). Every check that can stop the order runs before any money moves:
 * the price is re-validated, every name re-checked, and the supplier float
 * confirmed (I3). Registration itself (step 7) is queued, not run yet.
 */

type Result =
  | { error: string; field?: string; domain?: string; details?: string[] }
  | { redirectTo: string }
  // FR-D4 — hosts that did not answer, shown before paying. Nothing is created yet.
  | { warnings: string[] }

const NOT_CHARGED = "You haven't been charged."

/**
 * A database error, fit for a log line. PostgREST's `details` can quote the
 * failing row — the registrant's name, email and address — so only the code
 * and message are kept (N13).
 */
const dbError = (error: { code?: string; message: string } | null) => ({
  code: error?.code,
  err: error?.message,
})

export const placeOrder = authAction
  .inputSchema(
    z.object({
      registrant: registrantFormSchema,
      nameservers: z.string().max(2000).optional(),
      // FR-C10 — a host from our presets. Only its id travels: the
      // nameservers are read back from our table (N11).
      presetId: z.uuid().nullish(),
      // FR-C10 — a domain's own host, over the order's, in a mixed cart.
      lineHosts: lineHostsSchema.optional(),
      // FR-D4 — the customer has seen the warnings and pays anyway.
      hostWarningsSeen: z.boolean().optional(),
      // FR-C6 — the explicit irreversibility confirmation.
      confirmed: z.literal(true, { error: 'Tick the box to confirm the spelling' }),
      // The total the customer saw. If it moved, they see the new one first.
      expectedTotalKobo: z.number().int().positive(),
    }),
  )
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
    if (!checkoutOpenTo(ctx.user.email, env.CHECKOUT_ALLOWLIST)) {
      return { error: `Checkout isn't open yet. ${NOT_CHARGED}` }
    }
    // SEC-11: an account that keeps placing orders is paused before any
    // supplier or payment call is made on its behalf.
    const [recent, today] = await Promise.all([
      withinLimit(`place_order:${ctx.user.id}`, LIMITS.placeOrder),
      withinLimit(`place_order_day:${ctx.user.id}`, LIMITS.placeOrderDaily),
    ])
    if (!recent || !today) {
      logger.warn({ userId: ctx.user.id }, 'checkout rate limit reached')
      return {
        error: `Too many checkout attempts. ${NOT_CHARGED} Wait a few minutes, then try again.`,
      }
    }
    const payment = requirePaymentEnv()
    const service = createServiceClient()
    const nameservers = await chooseNameservers(service, parsedInput)
    if (!nameservers.ok) return { error: nameservers.error, field: nameservers.field }
    const registrant = toContact(parsedInput.registrant)

    // ── Price re-validation (FR-C4) ──────────────────────────────────────
    const cart = await getCartView()
    if (cart.state !== 'ready') return { error: 'Your cart is empty.' }
    const { lines, totals } = cart
    if (totals.needsAcknowledgement || totals.unavailableCount > 0) {
      return {
        error: 'Your cart needs a look before checkout — some prices or extensions changed.',
      }
    }
    if (totals.totalKobo !== parsedInput.expectedTotalKobo) {
      return {
        error: 'Your total has changed since this page loaded. Check the new total, then pay.',
      }
    }

    // ── Velocity (SEC-11) ────────────────────────────────────────────────
    // Stolen cards buy domains in bulk for phishing: a cap on domains per
    // account per day limits what one account can do before a person looks.
    const { data: allowance, error: allowanceError } = await service.rpc(
      'account_domain_allowance',
      { p_user_id: ctx.user.id },
    )
    const { ordered, max } = (allowance ?? {}) as { ordered?: number; max?: number }
    if (allowanceError || typeof ordered !== 'number' || typeof max !== 'number') {
      logger.error({ err: allowanceError?.message }, 'domain allowance could not be checked')
      return { error: `We couldn't complete checkout just now. ${NOT_CHARGED} Try again shortly.` }
    }
    if (ordered + lines.length > max) {
      return {
        error: `You can order up to ${max} domains a day, and this would take you to ${ordered + lines.length}. ${NOT_CHARGED} Remove some, or email ${BUSINESS.email} to raise your limit.`,
      }
    }

    // ── Each domain's host, checked in DNS (FR-C10, FR-D4) ───────────────
    const hosts = await planHosts(
      service,
      nameservers,
      parsedInput.lineHosts ?? [],
      lines.map((line) => line.domain),
    )
    if (!hosts.ok) return hosts.failure
    if (hosts.warnings.length > 0 && !parsedInput.hostWarningsSeen) {
      return { warnings: hosts.warnings }
    }

    // ── Availability re-check (FR-C7) ────────────────────────────────────
    const byTld = new Map<string, typeof lines>()
    for (const line of lines) byTld.set(line.tld, [...(byTld.get(line.tld) ?? []), line])
    const taken: string[] = []
    for (const [tld, group] of byTld) {
      const stems = group.map((line) => line.domain.slice(0, -(tld.length + 1)))
      // Past the gateway's 60-second cache: a cached answer is re-validated
      // before anyone pays for it (FR-S6, N4).
      const outcome = await checkAvailability(stems, [tld], 'high', { fresh: true })
      if (!outcome.ok) {
        return {
          error: `We couldn't confirm your domains are still free. ${NOT_CHARGED} Try again in a moment.`,
        }
      }
      for (const result of outcome.results) {
        if (result.status !== 'available') taken.push(result.domain)
      }
    }
    if (taken.length > 0) {
      const cartId = await findCartId({ kind: 'user', userId: ctx.user.id })
      if (cartId) {
        for (const line of lines.filter((candidate) => taken.includes(candidate.domain))) {
          await deleteLine(cartId, line.id)
        }
      }
      return {
        error: `${taken.join(', ')} ${taken.length === 1 ? 'was' : 'were'} registered by someone else and removed from your cart. ${NOT_CHARGED} Check your new total.`,
      }
    }

    // ── Float pre-flight (FR-C8) ─────────────────────────────────────────
    const [{ data: tldRows }, { data: settings }] = await Promise.all([
      service
        .from('tlds')
        .select('name, register_usd, renew_usd, is_country_code')
        .in('name', [...byTld.keys()]),
      service.from('pricing_settings').select('icann_fee_usd').single(),
    ])
    const costs = new Map<string, SupplierCost>(
      (tldRows ?? []).map((row) => [
        row.name,
        {
          registerUsd: Number(row.register_usd),
          renewUsd: Number(row.renew_usd),
          isCountryCode: Boolean(row.is_country_code),
        },
      ]),
    )
    let costUsd: number
    let balanceUsd: number
    try {
      costUsd = wholesaleCostUsd(lines, costs, Number(settings?.icann_fee_usd ?? 0))
      const balance = accountBalanceSchema.parse(
        await callGateway<unknown>({
          path: 'account/balance',
          signal: AbortSignal.timeout(15_000),
        }),
      )
      balanceUsd = balance.balanceUsd
    } catch (err) {
      logger.error({ err }, 'float pre-flight failed')
      return {
        error: `We couldn't complete checkout just now. ${NOT_CHARGED} Try again in a few minutes.`,
      }
    }
    const shortfall = balanceUsd < costUsd
    if (shortfall && !payment.testMode) {
      // I3 — never charge for what we cannot register. Ops must top up.
      logger.error({ costUsd, balanceUsd }, 'OPS: supplier float too low to accept an order')
      return { error: userMessageFor('SUPPLIER_INSUFFICIENT_FUNDS') }
    }
    if (shortfall) {
      logger.warn({ costUsd, balanceUsd }, 'test mode: float shortfall recorded, order allowed')
    }

    // The rate the order is priced at. Missing only if the rate was withdrawn
    // since the cart was priced — then nothing is saved and nothing charged.
    const rateId = await activeRateId(service)
    if (!rateId) {
      logger.error('no active FX rate at checkout')
      return { error: `Prices are unavailable right now. ${NOT_CHARGED} Try again shortly.` }
    }

    // ── Save the registrant for next time, as the user (RLS) ─────────────
    const contactProfileId = await saveDefaultContact(ctx.supabase, ctx.user.id, registrant)

    // ── Create the order (step 1) ────────────────────────────────────────
    // The Flutterwave account is shared with other apps; Paidly's webhook
    // routes notices by this prefix (solostack: app/api/webhooks/flutterwave).
    const txRef = `MDH-${randomUUID()}`
    const { data: order, error: orderError } = await service
      .from('orders')
      .insert({
        user_id: ctx.user.id,
        subtotal_kobo: totals.subtotalKobo,
        vat_pct: cart.vatPct,
        vat_kobo: totals.vatKobo,
        total_kobo: totals.totalKobo,
        fx_rate_id: rateId,
        tx_ref: txRef,
        registrant,
        contact_profile_id: contactProfileId,
        nameservers: hosts.order.nameservers,
        // Copied to the domain with the payment (record_order_payment, migration 26).
        nameserver_preset_id: hosts.order.presetId,
        float_check: shortfall ? 'shortfall_test_mode' : 'covered',
        test_mode: payment.testMode,
      })
      .select('id, order_number')
      .single()
    if (orderError || !order) {
      logger.error(dbError(orderError), 'order insert failed')
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    const { error: itemsError } = await service.from('order_items').insert(
      lines.map((line) => ({
        order_id: order.id,
        domain: line.domain,
        tld: line.tld,
        period_years: line.periodYears,
        privacy: line.privacyOffered ? line.privacy : false,
        auto_renew: line.autoRenew,
        price_kobo: line.payableKobo,
        renewal_kobo: line.renewalKobo,
        // FR-C10 — a domain's own host wins over the order's (migration 29).
        ...hosts.columnsFor(line.domain),
      })),
    )
    if (itemsError) {
      logger.error({ ...dbError(itemsError), orderId: order.id }, 'order items insert failed')
      await service.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    // ── Hand over to Flutterwave (step 5) ────────────────────────────────
    try {
      const redirectUrl = new URL('/app/checkout/complete', env.NEXT_PUBLIC_APP_URL)
      redirectUrl.searchParams.set('order', order.id)
      const link = await createPaymentLink({
        txRef,
        amountKobo: totals.totalKobo,
        redirectUrl: redirectUrl.toString(),
        customer: {
          email: ctx.user.email ?? registrant.email,
          name: `${registrant.firstName} ${registrant.lastName}`,
          phone: `+${registrant.phoneCountryCode}${registrant.phone}`,
        },
        orderNumber: order.order_number,
      })
      return { redirectTo: link }
    } catch (err) {
      logger.error({ err, orderId: order.id }, 'could not start payment')
      await service.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
      return {
        error: `We couldn't reach our payment provider. ${NOT_CHARGED} Try again in a moment.`,
      }
    }
  })

async function activeRateId(
  service: ReturnType<typeof createServiceClient>,
): Promise<string | null> {
  const { data } = await service.from('fx_rates').select('id').eq('status', 'active').maybeSingle()
  return data?.id ?? null
}
