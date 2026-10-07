import 'server-only'

import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { TRANSACTION_ID } from '../lib/flutterwave'
import type { ReturnCheckout } from '../queries/billing'
import { settleCharge } from './settle'

/**
 * What a return from Flutterwave's checkout comes to, as the page words it
 * (`?payment=`). Null: nothing to say (no checkout the person may see).
 * A cancelled return changes nothing — no charge was made — and a return
 * without a transaction waits for the webhook.
 *
 * Each return asks Flutterwave about a charge, with the key the shop and
 * Paidly share, and the query string is the browser's: anyone with a
 * checkout could replay any transaction id. So, as the shop's
 * checkout_return does, SQL counts the returns per checkout and per account
 * (`billing_return_allowed`, migration 54); past either limit, or when the
 * count cannot be asked, the answer is "pending" and the webhook settles the
 * charge. A charge for another checkout is "pending" too: it says nothing
 * about this one.
 */
export async function returnFromCheckout(
  checkout: ReturnCheckout | null,
  query: { status: string | null; transactionId: string | null },
): Promise<string | null> {
  if (!checkout) return null
  if (query.status === 'cancelled') return 'cancelled'
  if (!query.transactionId || !TRANSACTION_ID.test(query.transactionId)) return 'pending'
  if (!(await returnAllowed(checkout))) return 'pending'
  const outcome = await settleCharge(query.transactionId, {
    txRef: checkout.txRef,
    accountId: checkout.accountId,
  })
  switch (outcome) {
    case 'missing':
    case 'wrong_checkout':
      return 'pending'
    case 'renewal_failed':
    case 'unknown_reference':
    case 'not_ours':
      return 'mismatch'
    default:
      return outcome
  }
}

/** Whether this return may ask Flutterwave now (review 21). */
async function returnAllowed(checkout: ReturnCheckout): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('billing_return_allowed', {
    p_checkout_id: checkout.id,
    p_account_id: checkout.accountId,
  })
  if (error) {
    logger.error(
      { code: error.code ?? null },
      'the return limit could not be asked; the webhook settles it',
    )
    return false
  }
  if (data !== true) logger.info({ checkoutId: checkout.id }, 'payment return over its limit')
  return data === true
}
