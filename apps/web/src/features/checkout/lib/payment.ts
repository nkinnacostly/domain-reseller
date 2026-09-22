/**
 * Whether a Flutterwave transaction pays for an order (SEC-7). Everything the
 * redirect or webhook claims is re-read from the API first; this decides what
 * the re-read means. Pure, so every rule is testable.
 */
export type PaymentAssessment = 'paid' | 'pending' | 'failed' | 'mismatch'

export function assessTransaction(
  transaction: { tx_ref: string; status: string; amount: number; currency: string },
  order: { txRef: string; totalKobo: number },
): PaymentAssessment {
  // A transaction for another order, or in another currency, pays for nothing.
  if (transaction.tx_ref !== order.txRef || transaction.currency !== 'NGN') return 'mismatch'

  if (transaction.status === 'successful') {
    // Less than the order total is not a payment for it, whatever the status.
    return Math.round(transaction.amount * 100) >= order.totalKobo ? 'paid' : 'mismatch'
  }
  if (transaction.status === 'pending') return 'pending'
  return 'failed'
}
