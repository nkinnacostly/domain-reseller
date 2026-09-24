'use server'

import { randomUUID } from 'node:crypto'
import {
  accountBalanceSchema,
  authCodeSchema,
  GatewayError,
  transferCheckResultSchema,
  userMessageFor,
  vatKobo,
} from '@dr/shared'
import { z } from 'zod'
import { checkoutOpenTo } from '@/features/checkout/lib/access'
import { registrantFormSchema, toContact } from '@/features/checkout/lib/contact'
import { saveDefaultContact } from '@/features/checkout/queries/registrant'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { evaluateTransfer } from '../lib/eligibility'
import { parseTransferQuery, TRANSFER_QUERY_MESSAGES } from '../lib/href'
import {
  canStartTransfer,
  HELD_HERE,
  TRANSFER_REFUSAL_MESSAGE,
  TRANSFER_UNDER_WAY,
  takesTransfers,
  transferCostUsd,
} from '../lib/start'
import { lookupDomain } from '../queries/rdap-lookup'

/**
 * Starts a transfer in (PRD FR-T1, FR-T2): an order with one transfer line,
 * paid on Flutterwave's page. Every check that can stop it runs before any
 * money moves — the extension takes transfers at a price we hold, the name
 * is not already here, the registry shows nothing in the way, the supplier
 * accepts the code (N4), the price is the one the customer saw, and the float
 * covers it (I3). The transfer itself is queued when the payment is
 * confirmed, and sent by the gateway, which reads the registry first (I1).
 *
 * The code is written only to `transfer_secrets`, which nobody but the
 * service can read, and never to a log line (N13).
 */

type Result = { error: string; field?: 'authCode' } | { redirectTo: string }

const NOT_CHARGED = "You haven't been charged."

/** Code and message only: PostgREST's `details` can quote the row it refused (N13). */
const dbError = (error: { code?: string; message: string } | null) => ({
  code: error?.code,
  err: error?.message,
})

export const placeTransfer = authAction
  .inputSchema(
    z.object({
      domain: z.string().max(300),
      authCode: authCodeSchema,
      registrant: registrantFormSchema,
      // The total the customer saw. If it moved, they see the new one first.
      expectedTotalKobo: z.number().int().positive(),
    }),
  )
  .action(async ({ parsedInput, ctx }): Promise<Result> => {
    if (!checkoutOpenTo(ctx.user.email, env.CHECKOUT_ALLOWLIST)) {
      return { error: `Payments aren't open yet. ${NOT_CHARGED}` }
    }
    // SEC-11: the same limits as checkout — each attempt checks a code with
    // the supplier and opens a payment.
    const [recent, today] = await Promise.all([
      withinLimit(`place_order:${ctx.user.id}`, LIMITS.placeOrder),
      withinLimit(`place_order_day:${ctx.user.id}`, LIMITS.placeOrderDaily),
    ])
    if (!recent || !today) {
      logger.warn({ userId: ctx.user.id }, 'transfer rate limit reached')
      return { error: `Too many attempts. ${NOT_CHARGED} Wait a few minutes, then try again.` }
    }
    const payment = requirePaymentEnv()

    const query = parseTransferQuery(parsedInput.domain)
    if (!query.ok) return { error: `${TRANSFER_QUERY_MESSAGES[query.reason]}.` }
    const { domain, tld } = query

    // ── The extension: sold, not paused, and priced for a transfer (N5b) ─
    const service = createServiceClient()
    const [priced, { data: tldRow }] = await Promise.all([
      getPricedCatalogue(),
      service
        .from('tlds')
        .select('transfer_usd, is_country_code, is_transferable')
        .eq('name', tld)
        .maybeSingle(),
    ])
    if (!priced) {
      return { error: `Prices are unavailable right now. ${NOT_CHARGED} Try again shortly.` }
    }
    const pricing = priced.tlds.find((entry) => entry.tld === tld)
    if (!pricing?.transfer || !tldRow || !takesTransfers(tldRow)) {
      return { error: `We don’t take transfers for .${tld} yet. ${NOT_CHARGED}` }
    }

    // ── Not already here (on this side) ──────────────────────────────────
    const { data: rows, error: rowsError } = await service
      .from('domains')
      .select('user_id, local_status')
      .eq('domain_name', domain)
      .eq('test_mode', payment.testMode)
      .neq('source', 'demo')
      .in('local_status', [...HELD_HERE, ...TRANSFER_UNDER_WAY])
    if (rowsError) {
      logger.error(dbError(rowsError), 'domains could not be read for a transfer')
      return { error: `We couldn't complete this just now. ${NOT_CHARGED} Try again shortly.` }
    }
    const here = rows ?? []
    const held = here.filter((row) => (HELD_HERE as readonly string[]).includes(row.local_status))
    if (held.some((row) => row.user_id === ctx.user.id)) {
      return { error: `${domain} is already on your account. ${NOT_CHARGED}` }
    }
    if (held.length > 0) {
      return {
        error: `${domain} is already registered with us, so it can’t be transferred in. ${NOT_CHARGED}`,
      }
    }
    if (here.some((row) => row.user_id === ctx.user.id)) {
      return { error: `A transfer of ${domain} is already paid for and under way. ${NOT_CHARGED}` }
    }

    // ── What the registry shows (FR-T1, FR-T7) ───────────────────────────
    const start = canStartTransfer(
      evaluateTransfer({
        domain,
        tld,
        offer: 'offered',
        lookup: await lookupDomain(domain),
        now: new Date(),
      }),
    )
    if (!start.ok) return { error: `${start.reason} ${NOT_CHARGED}` }

    // ── Price re-validation (FR-C4) ──────────────────────────────────────
    const subtotal = pricing.transfer.priceKobo
    const vat = vatKobo(subtotal, priced.vatPct)
    const total = subtotal + vat
    if (total !== parsedInput.expectedTotalKobo) {
      return {
        error: `The transfer price has changed since this page loaded. ${NOT_CHARGED} Check the new total, then pay.`,
      }
    }

    // ── The supplier's check of the code, then the float (N4) ────────────
    if (!(await withinLimit(`transfer_check:${domain}`, LIMITS.transferCheckDomain))) {
      logger.warn({ tld }, 'transfer check limit reached for a domain')
      return {
        error: `Too many transfer codes have been tried for ${domain}. ${NOT_CHARGED} Try again in an hour.`,
      }
    }
    let check: z.infer<typeof transferCheckResultSchema>
    try {
      check = transferCheckResultSchema.parse(
        await callGateway<unknown>({
          path: 'transfers/check',
          body: { domainName: domain, authCode: parsedInput.authCode, testMode: payment.testMode },
          signal: AbortSignal.timeout(20_000),
        }),
      )
    } catch (err) {
      if (err instanceof GatewayError && err.code === 'TRANSFERS_UNAVAILABLE') {
        logger.error({ testMode: payment.testMode }, 'OPS: the gateway does not work this side')
        return { error: `Transfers can’t be started right now. ${NOT_CHARGED} Try again later.` }
      }
      logger.error(
        { code: err instanceof GatewayError ? err.code : 'INVALID' },
        'transfer check failed',
      )
      return {
        error: `We couldn't check the transfer code just now. ${NOT_CHARGED} Try again in a few minutes.`,
      }
    }
    if (!check.transferable) {
      return {
        error: `${TRANSFER_REFUSAL_MESSAGE[check.reason]} ${NOT_CHARGED}`,
        field: 'authCode',
      }
    }

    const [{ data: settings }, { data: rate }] = await Promise.all([
      service.from('pricing_settings').select('icann_fee_usd').maybeSingle(),
      service.from('fx_rates').select('id').eq('status', 'active').maybeSingle(),
    ])
    if (!rate) {
      logger.error('no active FX rate at transfer checkout')
      return { error: `Prices are unavailable right now. ${NOT_CHARGED} Try again shortly.` }
    }
    const costUsd = transferCostUsd(
      { transferUsd: Number(tldRow.transfer_usd), isCountryCode: Boolean(tldRow.is_country_code) },
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
      logger.error({ err }, 'transfer float pre-flight failed')
      return {
        error: `We couldn't complete this just now. ${NOT_CHARGED} Try again in a few minutes.`,
      }
    }
    const shortfall = balanceUsd < costUsd
    if (shortfall && !payment.testMode) {
      logger.error({ costUsd, balanceUsd }, 'OPS: supplier float too low to accept a transfer')
      return { error: userMessageFor('SUPPLIER_INSUFFICIENT_FUNDS') }
    }
    if (shortfall) {
      logger.warn({ costUsd, balanceUsd }, 'test mode: float shortfall recorded, transfer allowed')
    }

    // ── The order, its one line, and the code in the vault ───────────────
    const registrant = toContact(parsedInput.registrant)
    const contactProfileId = await saveDefaultContact(ctx.supabase, ctx.user.id, registrant)
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
        registrant,
        contact_profile_id: contactProfileId,
        float_check: shortfall ? 'shortfall_test_mode' : 'covered',
        test_mode: payment.testMode,
      })
      .select('id, order_number')
      .single()
    if (orderError || !order) {
      logger.error(dbError(orderError), 'transfer order insert failed')
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    let lineId: string | null = null
    /** Anything after the order row: close it, and take the code back out of the vault. */
    const abandon = async () => {
      await service.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
      if (lineId) await service.from('transfer_secrets').delete().eq('order_item_id', lineId)
    }

    const { data: line, error: lineError } = await service
      .from('order_items')
      .insert({
        order_id: order.id,
        item_type: 'transfer',
        domain,
        tld,
        // The Transfer call's period: the year a transfer adds where the registry adds one.
        period_years: 1,
        privacy: false,
        auto_renew: true,
        price_kobo: subtotal,
        renewal_kobo: pricing.renewal.priceKobo,
      })
      .select('id')
      .single()
    if (lineError || !line) {
      logger.error({ ...dbError(lineError), orderId: order.id }, 'transfer line insert failed')
      await abandon()
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }
    lineId = line.id

    const { error: secretError } = await service
      .from('transfer_secrets')
      .insert({ order_item_id: line.id, auth_code: parsedInput.authCode })
    if (secretError) {
      logger.error({ ...dbError(secretError), orderId: order.id }, 'transfer code not stored')
      await abandon()
      return { error: `We couldn't create your order. ${NOT_CHARGED}` }
    }

    // ── Hand over to Flutterwave ─────────────────────────────────────────
    try {
      const redirectUrl = new URL('/app/checkout/complete', env.NEXT_PUBLIC_APP_URL)
      redirectUrl.searchParams.set('order', order.id)
      const link = await createPaymentLink({
        txRef,
        amountKobo: total,
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
      logger.error({ err, orderId: order.id }, 'could not start transfer payment')
      await abandon()
      return {
        error: `We couldn't reach our payment provider. ${NOT_CHARGED} Try again in a moment.`,
      }
    }
  })
