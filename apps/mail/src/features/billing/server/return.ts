import 'server-only'

import { TRANSACTION_ID } from '../lib/flutterwave'
import type { ReturnCheckout } from '../queries/billing'
import { settleCharge } from './settle'

/**
 * What a return from Flutterwave's checkout comes to, as the page words it
 * (`?payment=`). Null: nothing to say (no checkout the person may see).
 * A cancelled return changes nothing — no charge was made — and a return
 * without a transaction waits for the webhook.
 */
export async function returnFromCheckout(
  checkout: ReturnCheckout | null,
  query: { status: string | null; transactionId: string | null },
): Promise<string | null> {
  if (!checkout) return null
  if (query.status === 'cancelled') return 'cancelled'
  if (!query.transactionId || !TRANSACTION_ID.test(query.transactionId)) return 'pending'
  const outcome = await settleCharge(query.transactionId, {
    txRef: checkout.txRef,
    accountId: checkout.accountId,
  })
  switch (outcome) {
    case 'missing':
      return 'pending'
    case 'renewal_failed':
    case 'unknown_reference':
    case 'not_ours':
      return 'mismatch'
    default:
      return outcome
  }
}
