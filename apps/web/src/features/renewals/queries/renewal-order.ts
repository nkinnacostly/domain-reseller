import 'server-only'

import { accountBalanceSchema } from '@dr/shared'
import { env } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import type { createServiceClient } from '@/lib/supabase/service'

/**
 * The two steps every renewal order shares, one domain or many (FR-RN1,
 * FR-P4): the float pre-flight before anything is created, and the hand
 * over to Flutterwave after.
 */

export type FloatVerdict =
  | { ok: true; shortfall: boolean }
  | { ok: false; reason: 'unreadable' | 'insufficient' }

/**
 * FR-C8, I3 — does the supplier float cover what these renewals cost us?
 * A live payment is refused when it does not; a test payment goes ahead
 * with the shortfall recorded on the order. A balance that cannot be read
 * refuses either way — fails closed.
 */
export async function checkFloat(costUsd: number, testMode: boolean): Promise<FloatVerdict> {
  let balanceUsd: number
  try {
    balanceUsd = accountBalanceSchema.parse(
      await callGateway<unknown>({ path: 'account/balance', signal: AbortSignal.timeout(15_000) }),
    ).balanceUsd
  } catch (err) {
    logger.error({ err }, 'renewal float pre-flight failed')
    return { ok: false, reason: 'unreadable' }
  }
  const shortfall = balanceUsd < costUsd
  if (shortfall && !testMode) {
    logger.error({ costUsd, balanceUsd }, 'OPS: supplier float too low to accept a renewal')
    return { ok: false, reason: 'insufficient' }
  }
  if (shortfall) {
    logger.warn({ costUsd, balanceUsd }, 'test mode: float shortfall recorded, renewal allowed')
  }
  return { ok: true, shortfall }
}

/**
 * Opens the Flutterwave payment for a renewal order just created. If it
 * cannot be opened the order is closed, so nothing is left to be paid by
 * accident.
 */
export async function startRenewalPayment(
  service: ReturnType<typeof createServiceClient>,
  order: { id: string; order_number: string },
  payment: {
    txRef: string
    totalKobo: number
    customer: { email: string; name: string; phone?: string }
  },
): Promise<{ redirectTo: string } | { error: string }> {
  try {
    const redirectUrl = new URL('/app/checkout/complete', env.NEXT_PUBLIC_APP_URL)
    redirectUrl.searchParams.set('order', order.id)
    const link = await createPaymentLink({
      txRef: payment.txRef,
      amountKobo: payment.totalKobo,
      redirectUrl: redirectUrl.toString(),
      customer: payment.customer,
      orderNumber: order.order_number,
    })
    return { redirectTo: link }
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'could not start renewal payment')
    await service.from('orders').update({ status: 'cancelled' }).eq('id', order.id)
    return {
      error:
        "We couldn't reach our payment provider. You haven't been charged. Try again in a moment.",
    }
  }
}
