import 'server-only'

import { requirePaymentEnv } from '@/lib/env'
import { type FlutterwaveTransaction, verifyTransaction } from '@/lib/flutterwave'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { assessTransaction, type FinalizeOutcome, transactionRecord } from '../lib/payment'

type Incident = 'tx_ref_mismatch' | 'currency_mismatch' | 'unrecorded_payment' | 'mode_mismatch'

const kobo = (transaction: FlutterwaveTransaction) => Math.round(transaction.amount * 100)

/**
 * Money that arrived but could not be applied is recorded, not just logged,
 * so it raises an alert (migration 15). Statuses and amounts only — the
 * transaction's customer details stay out of it (N13).
 */
async function recordIncident(
  service: ReturnType<typeof createServiceClient>,
  kind: Incident,
  orderId: string,
  reference: string,
  detail: Record<string, string | number | boolean>,
) {
  const { error } = await service.rpc('record_payment_incident', {
    p_kind: kind,
    p_order_id: orderId,
    p_provider_reference: reference,
    p_detail: detail,
  })
  if (error) logger.error({ err: error.message, orderId, kind }, 'payment incident not recorded')
}

const facts = (transaction: FlutterwaveTransaction) => ({
  status: transaction.status,
  currency: transaction.currency,
  amount_kobo: kobo(transaction),
})

/**
 * Settles an order against a Flutterwave transaction (PRD §13.4 steps 5–6).
 *
 * Called from the payment redirect, the webhook and the gateway's sweeper —
 * in any order, any number of times. The transaction is always re-read from
 * Flutterwave first (SEC-7); the database functions record it at most once,
 * and send back any money that should not be kept (a short payment, a
 * second charge).
 *
 * `unverified` means nothing is settled yet and it is worth asking again:
 * Flutterwave could not be reached, or the database could not record what it
 * said. The webhook answers that with a 503 so Flutterwave sends it again.
 */
export async function finalizePayment(
  orderId: string,
  transactionId: string,
): Promise<FinalizeOutcome> {
  const service = createServiceClient()
  const { data: order, error: orderError } = await service
    .from('orders')
    .select('id, tx_ref, total_kobo, status, test_mode')
    .eq('id', orderId)
    .maybeSingle()
  if (orderError) {
    logger.error({ err: orderError.message, orderId }, 'order could not be read to settle it')
    return 'unverified'
  }
  if (!order) return 'mismatch'

  // A test order is settled with the test key, a live one with the live key
  // (N12). Crossed, the key would read the other side's transactions.
  const { testMode } = requirePaymentEnv()
  if (order.test_mode !== testMode) {
    logger.error({ orderId, orderTestMode: order.test_mode }, 'order and payment key disagree')
    await recordIncident(service, 'mode_mismatch', order.id, transactionId, {
      order_test_mode: order.test_mode,
    })
    return 'mismatch'
  }

  const verified = await verifyTransaction(transactionId)
  if (verified.kind === 'unreachable') return 'unverified'
  if (verified.kind === 'missing') return 'pending'
  const { transaction } = verified

  const verdict = assessTransaction(transaction, {
    txRef: order.tx_ref,
    totalKobo: Number(order.total_kobo),
  })

  if (verdict === 'wrong_order' || verdict === 'wrong_currency') {
    logger.error({ orderId, transactionId, verdict }, 'payment does not match order')
    await recordIncident(
      service,
      verdict === 'wrong_order' ? 'tx_ref_mismatch' : 'currency_mismatch',
      order.id,
      String(transaction.id),
      facts(transaction),
    )
    return 'mismatch'
  }
  if (verdict === 'pending' || verdict === 'failed') return verdict

  const payment = {
    p_order_id: order.id,
    p_provider_reference: String(transaction.id),
    p_amount_kobo: kobo(transaction),
    p_currency: transaction.currency,
    p_method: transaction.payment_type ?? '',
    // Never the whole answer: it carries the customer and a reusable card token.
    p_raw: transactionRecord(transaction),
  }

  const recorded =
    verdict === 'underpaid'
      ? await service.rpc('record_underpayment', payment)
      : await service.rpc('record_order_payment', payment)
  if (recorded.error) {
    // Paid at Flutterwave but not recorded here: the one state that must
    // never go unnoticed (§13.4). The webhook is retried, the sweeper looks
    // again, and ops are alerted. Code and message only: never the payload.
    logger.error(
      { err: recorded.error.message, code: recorded.error.code, orderId, verdict },
      'verified payment could not be recorded',
    )
    await recordIncident(
      service,
      'unrecorded_payment',
      order.id,
      String(transaction.id),
      facts(transaction),
    )
    return 'unverified'
  }
  return verdict
}

/** The customer abandoned or cancelled the payment: nothing was charged. */
export async function markOrderCancelled(orderId: string): Promise<void> {
  await createServiceClient()
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)
    .eq('status', 'awaiting_payment')
}
