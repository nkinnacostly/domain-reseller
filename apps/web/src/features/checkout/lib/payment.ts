/**
 * Whether a Flutterwave transaction pays for an order (SEC-7). The rules are
 * shared with the gateway's payment sweeper, so a charge is judged the same
 * way whichever of them finds it.
 */
export {
  assessTransaction,
  type TransactionVerdict,
  transactionRecord,
} from '@dr/shared/payments'

/** What the customer is told about the payment, on the order page. */
export type PaymentAssessment = 'paid' | 'underpaid' | 'pending' | 'failed' | 'mismatch'

/**
 * What settling a payment came to. `unverified`: Flutterwave could not be
 * asked, or the answer could not be recorded — nothing is settled yet, and
 * the webhook asks Flutterwave to send it again. People see it as pending.
 */
export type FinalizeOutcome = PaymentAssessment | 'unverified'
