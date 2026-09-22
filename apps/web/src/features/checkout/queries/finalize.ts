import 'server-only'

import { verifyTransaction } from '@/lib/flutterwave'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { assessTransaction, type PaymentAssessment } from '../lib/payment'

/**
 * Settles an order against a Flutterwave transaction (PRD §13.4 steps 5–6).
 *
 * Called from the payment redirect and from the webhook — in any order, any
 * number of times. The transaction is always re-read from Flutterwave first
 * (SEC-7); the database function records it at most once.
 */
export async function finalizePayment(
  orderId: string,
  transactionId: string,
): Promise<PaymentAssessment> {
  const service = createServiceClient()
  const { data: order } = await service
    .from('orders')
    .select('id, tx_ref, total_kobo, status')
    .eq('id', orderId)
    .maybeSingle()
  if (!order) return 'mismatch'

  const transaction = await verifyTransaction(transactionId)
  if (!transaction) return 'pending'

  const assessment = assessTransaction(transaction, {
    txRef: order.tx_ref,
    totalKobo: Number(order.total_kobo),
  })

  if (assessment === 'mismatch') {
    // Someone presented a transaction that does not pay for this order.
    logger.error({ orderId, transactionId }, 'payment does not match order')
    return assessment
  }
  if (assessment !== 'paid') return assessment

  const { error } = await service.rpc('record_order_payment', {
    p_order_id: order.id,
    p_provider_reference: String(transaction.id),
    p_amount_kobo: Math.round(transaction.amount * 100),
    p_currency: transaction.currency,
    p_method: transaction.payment_type ?? '',
    p_raw: transaction,
  })
  if (error) {
    // Paid at Flutterwave but not recorded here: the one state that must
    // never go unnoticed (§13.4). The webhook retries; ops must look too.
    logger.error({ err: error, orderId }, 'verified payment could not be recorded')
    return 'pending'
  }
  return 'paid'
}

/** The customer abandoned or cancelled the payment: nothing was charged. */
export async function markOrderCancelled(orderId: string): Promise<void> {
  await createServiceClient()
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)
    .eq('status', 'awaiting_payment')
}
