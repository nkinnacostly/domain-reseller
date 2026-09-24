import { ORDER_TX_REF_PREFIX } from '@dr/shared'
import { chargeTookMoney, type Flutterwave } from './flutterwave'

/**
 * Whether a registration is paid for, by Flutterwave's word (SEC-7).
 *
 * A payment row is written by our server after it has verified the charge —
 * but anyone holding the service key could write one too, and a registration
 * spends real money from our float and cannot be undone. So before a line is
 * registered, the charge behind it is read back from Flutterwave and must be
 * this order's: its reference, a successful naira charge, the amount we
 * recorded, and at least the order total.
 */

/** The paying charge as our database records it (claim_job, migration 20). */
export type PaymentFacts = {
  orderTxRef: string
  orderTotalKobo: number
  /** Flutterwave's transaction id; null when the order has no recorded payment. */
  reference: string | null
  amountKobo: number | null
  currency: string | null
  status: string | null
}

export type PaymentCheck =
  | { kind: 'verified' }
  /** Flutterwave could not be asked. Nothing is known yet: ask again later. */
  | { kind: 'unknown'; code: string; message: string }
  /** Not a payment we can register against. A person looks; nothing is registered or refunded. */
  | { kind: 'refused'; code: string; message: string }

export async function checkPayment(
  flutterwave: Flutterwave,
  facts: PaymentFacts | null,
): Promise<PaymentCheck> {
  const refuse = (message: string): PaymentCheck => ({
    kind: 'refused',
    code: 'PAYMENT_NOT_VERIFIED',
    message,
  })

  if (!facts?.reference) return refuse('The order has no recorded payment')
  if (!facts.orderTxRef.startsWith(ORDER_TX_REF_PREFIX)) return refuse('The order is not ours')
  if (facts.status !== 'successful' || facts.currency !== 'NGN') {
    return refuse('The recorded payment is not a successful naira charge')
  }
  if (facts.amountKobo === null || facts.amountKobo < facts.orderTotalKobo) {
    return refuse('The recorded payment is below the order total')
  }

  const verified = await flutterwave.verifyTransaction(facts.reference)
  if (verified.kind === 'unknown') {
    return {
      kind: 'unknown',
      code: verified.code,
      message: `Could not read the charge: ${verified.message}`,
    }
  }
  if (verified.kind === 'rejected') {
    return refuse('Flutterwave has no such charge for this key')
  }
  const charge = verified.data
  if (charge.txRef !== facts.orderTxRef) return refuse('The charge is for another reference')
  if (charge.currency !== 'NGN') return refuse('The charge is not in naira')
  if (charge.amountKobo !== facts.amountKobo) return refuse('The charge is for another amount')
  if (!chargeTookMoney(charge.status)) return refuse(`The charge is ${charge.status}`)
  return { kind: 'verified' }
}
