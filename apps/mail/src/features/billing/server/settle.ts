import 'server-only'

import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { MAIL_TX_REF_PREFIX } from '../lib/flutterwave'
import { requireBillingEnv } from './env'
import { verifyTransaction } from './flutterwave'
import { recordIncident, stopReplaced } from './provider'

/**
 * Settles one Flutterwave transaction against Mail's billing (MAIL-SPEC §8,
 * SEC-7). Called by the payment redirect and the webhook, in any order, any
 * number of times. The charge is always re-read from Flutterwave first; what
 * Flutterwave said goes to `record_billing_charge` (migration 50), which
 * checks the reference, the side, the currency and the amount, and records
 * it once — on Flutterwave's transaction id.
 *
 * `unverified`: Flutterwave could not be asked, or the database could not
 * record what it said. Nothing is settled; the webhook answers 503 so
 * Flutterwave (through Paidly) sends it again. `wrong_checkout`: the redirect
 * named a charge for another checkout — recorded as an incident, settled by
 * its own webhook, and nothing to say about this checkout.
 */
export type SettleOutcome =
  | 'paid'
  | 'renewed'
  | 'already'
  | 'pending'
  | 'failed'
  | 'renewal_failed'
  | 'unapplied'
  | 'mismatch'
  | 'unknown_reference'
  | 'missing'
  | 'not_ours'
  | 'wrong_checkout'
  | 'unverified'

const OUTCOMES = new Set<string>([
  'paid',
  'renewed',
  'already',
  'pending',
  'failed',
  'renewal_failed',
  'unapplied',
  'mismatch',
  'unknown_reference',
])

export async function settleCharge(
  transactionId: string,
  /** From the redirect: the checkout the person came back from. */
  expected?: { txRef: string; accountId: string },
): Promise<SettleOutcome> {
  const settings = requireBillingEnv()
  const verified = await verifyTransaction(settings, transactionId)
  if (verified.kind === 'unreachable') return 'unverified'
  if (verified.kind === 'missing') return 'missing'
  const { charge } = verified
  const service = createServiceClient()

  if (expected && charge.txRef !== expected.txRef) {
    // A charge presented for a checkout it is not for.
    await recordIncident(service, settings, 'tx_ref_mismatch', {
      accountId: expected.accountId,
      reference: charge.id,
      detail: { status: charge.status, amount_kobo: charge.amountKobo },
    })
    return 'wrong_checkout'
  }
  // The account is shared: another app's charge is never ours to settle.
  if (!charge.txRef.startsWith(MAIL_TX_REF_PREFIX)) return 'not_ours'

  const { data, error } = await service.rpc('record_billing_charge', {
    p_test_mode: settings.testMode,
    p_transaction_id: charge.id,
    p_tx_ref: charge.txRef,
    p_status: charge.status,
    p_amount_kobo: charge.amountKobo,
    p_currency: charge.currency,
    p_method: charge.method,
    p_card_last4: charge.cardLast4 as string,
    p_card_brand: charge.cardBrand as string,
    // Never the whole answer: it carries the customer and a reusable card token.
    p_raw: charge.record,
  })
  const answer = data as {
    ok?: boolean
    outcome?: string
    reason?: string
    cancelTransactions?: unknown
  } | null
  if (error || answer?.ok !== true || !OUTCOMES.has(String(answer.outcome))) {
    // Confirmed at Flutterwave, not recorded here: the one state that must never go unnoticed.
    logger.error(
      { code: error?.code, transactionId: charge.id },
      'verified charge could not be recorded',
    )
    if (charge.status === 'successful') {
      await recordIncident(service, settings, 'unrecorded_payment', {
        reference: charge.id,
        detail: { status: charge.status, amount_kobo: charge.amountKobo },
      })
    }
    return 'unverified'
  }

  const outcome = answer.outcome as SettleOutcome
  if (outcome === 'unapplied' || outcome === 'mismatch' || outcome === 'unknown_reference') {
    // SQL recorded the incident row; say it loudly here too.
    logger.error(
      { outcome, reason: answer.reason ?? null, transactionId: charge.id },
      'billing incident: a person must look',
    )
  }
  const cancel = Array.isArray(answer.cancelTransactions)
    ? answer.cancelTransactions.filter((id): id is string => typeof id === 'string')
    : []
  if (cancel.length > 0) await stopReplaced(service, settings, expected?.accountId ?? null, cancel)
  logger.info({ outcome, transactionId: charge.id }, 'billing charge settled')
  return outcome
}
