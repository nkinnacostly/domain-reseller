'use server'

import { randomUUID } from 'node:crypto'
import { accountBalanceSchema, userMessageFor } from '@dr/shared'
import { z } from 'zod'
import { getCartView } from '@/features/cart/queries/cart'
import { deleteLine, findCartId } from '@/features/cart/queries/store'
import { checkAvailability } from '@/features/search/queries/availability'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { authAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { checkoutOpenTo } from '../lib/access'
import { registrantFormSchema, toContact } from '../lib/contact'
import { type SupplierCost, wholesaleCostUsd } from '../lib/cost'
import { parseNameservers } from '../lib/nameservers'

/**
 * Places an order and hands the customer to Flutterwave (PRD §13.4 steps
 * 1–5). Every check that can stop the order runs before any money moves:
 * the price is re-validated, every name re-checked, and the supplier float
 * confirmed (I3). Registration itself (step 7) is queued, not run yet.
 */

type Result = { error: string; field?: string } | { redirectTo: string }

const NOT_CHARGED = "You haven't been charged."

export const placeOrder = authAction
  .inputSchema(
    z.object({
      registrant: registrantFormSchema,
      nameservers: z.string().max(2000).optional(),
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
    const payment = requirePaymentEnv()
    const nameservers = parseNameservers(parsedInput.nameservers)
    if (!nameservers.ok) return { error: nameservers.error, field: 'nameservers' }
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

    // ── Availability re-check (FR-C7) ────────────────────────────────────
    const byTld = new Map<string, typeof lines>()
    for (const line of lines) byTld.set(line.tld, [...(byTld.get(line.tld) ?? []), line])
    const taken: string[] = []
    for (const [tld, group] of byTld) {
      const stems = group.map((line) => line.domain.slice(0, -(tld.length + 1)))
      const outcome = await checkAvailability(stems, [tld], 'high')
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
    const service = createServiceClient()
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

    // ── Save the registrant for next time, as the user (RLS) ─────────────
    const contactRow = {
      user_id: ctx.user.id,
      label: 'Registrant',
      first_name: registrant.firstName,
      last_name: registrant.lastName,
      company: registrant.company ?? null,
      email: registrant.email,
      phone: registrant.phone,
      phone_country_code: registrant.phoneCountryCode,
      address_line1: registrant.addressLine1,
      address_line2: registrant.addressLine2 ?? null,
      city: registrant.city,
      state: registrant.state,
      zip_code: registrant.zipCode,
      country: registrant.country,
      is_default: true,
    }
    const { data: existing } = await ctx.supabase
      .from('contact_profiles')
      .select('id')
      .eq('user_id', ctx.user.id)
      .eq('is_default', true)
      .maybeSingle()
    const saved = existing
      ? await ctx.supabase
          .from('contact_profiles')
          .update(contactRow)
          .eq('id', existing.id)
          .select('id')
          .single()
      : await ctx.supabase.from('contact_profiles').insert(contactRow).select('id').single()
    if (saved.error) logger.warn({ err: saved.error }, 'could not save default contact')

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
        fx_rate_id: await activeRateId(service),
        tx_ref: txRef,
        registrant,
        contact_profile_id: saved.data?.id ?? null,
        nameservers: nameservers.nameservers,
        float_check: shortfall ? 'shortfall_test_mode' : 'covered',
        test_mode: payment.testMode,
      })
      .select('id, order_number')
      .single()
    if (orderError || !order) {
      logger.error({ err: orderError }, 'order insert failed')
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
      })),
    )
    if (itemsError) {
      logger.error({ err: itemsError }, 'order items insert failed')
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

async function activeRateId(service: ReturnType<typeof createServiceClient>): Promise<string> {
  const { data } = await service.from('fx_rates').select('id').eq('status', 'active').single()
  if (!data) throw new Error('No active FX rate')
  return data.id
}
