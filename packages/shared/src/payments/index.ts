/**
 * Whether a Flutterwave transaction pays for an order (SEC-7), shared by the
 * web app (redirect and webhook) and the gateway's payment sweeper, so a
 * charge is judged the same way whichever of them finds it first.
 */

export type TransactionVerdict =
  | 'paid'
  // A successful naira charge below the total: it pays for nothing, and every
  // kobo of it is refunded (migration 15).
  | 'underpaid'
  | 'pending'
  | 'failed'
  // A transaction for another order — presented by mistake, or by someone
  // trying to pass one payment off for two orders.
  | 'wrong_order'
  // Not naira. Never applied, and not refunded automatically: a person looks.
  | 'wrong_currency'

export type TransactionFacts = {
  tx_ref: string
  status: string
  /** What we asked for, in naira — excluding any fee the customer paid on top. */
  amount: number
  currency: string
}

/** Kobo from Flutterwave's naira amount, which can carry float noise (199.99 → 19999). */
export function nairaToKobo(naira: number): number {
  return Math.round(naira * 100)
}

export function assessTransaction(
  transaction: TransactionFacts,
  order: { txRef: string; totalKobo: number },
): TransactionVerdict {
  if (transaction.tx_ref !== order.txRef) return 'wrong_order'
  if (transaction.currency !== 'NGN') return 'wrong_currency'

  if (transaction.status === 'successful') {
    return nairaToKobo(transaction.amount) >= order.totalKobo ? 'paid' : 'underpaid'
  }
  if (transaction.status === 'pending') return 'pending'
  return 'failed'
}

/**
 * What of a verified transaction we keep, as `payments.raw`. Flutterwave's
 * answer also carries the customer's name, email and phone, the card's
 * digits and a reusable card token — which, with our secret key, can charge
 * that card again. None of that is ours to hold (N13), so only these
 * fields, and only as plain strings and numbers, are kept.
 */
const KEPT_FIELDS = [
  'id',
  'tx_ref',
  'flw_ref',
  'amount',
  'charged_amount',
  'app_fee',
  'merchant_fee',
  'currency',
  'status',
  'payment_type',
  'created_at',
] as const

export type TransactionRecord = Partial<Record<(typeof KEPT_FIELDS)[number], string | number>>

export function transactionRecord(transaction: unknown): TransactionRecord {
  const record: TransactionRecord = {}
  if (!transaction || typeof transaction !== 'object') return record
  const source = transaction as Record<string, unknown>
  for (const field of KEPT_FIELDS) {
    const value = source[field]
    if (typeof value === 'string') record[field] = value.slice(0, 200)
    else if (typeof value === 'number' && Number.isFinite(value)) record[field] = value
  }
  return record
}

/** Flutterwave marks test keys `FLWSECK_TEST-` / `FLWPUBK_TEST-`. */
export function isTestSecretKey(secretKey: string): boolean {
  return secretKey.includes('_TEST-')
}

/** The only host a live key may be sent to. */
export const FLUTTERWAVE_LIVE_API_URL = 'https://api.flutterwave.com/v3'

/**
 * Every order's reference starts with this. The Flutterwave account is shared
 * with other apps, and Paidly forwards only these here; a charge without it
 * was never ours.
 */
export const ORDER_TX_REF_PREFIX = 'MDH-'
