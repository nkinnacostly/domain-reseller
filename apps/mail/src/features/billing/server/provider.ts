import 'server-only'

import { logger } from '@/lib/logger'
import type { MailServiceClient } from '@/lib/supabase/service'
import { isStopped } from '../lib/flutterwave'
import type { BillingSettings } from './env'
import { findSubscription, setSubscription } from './flutterwave'

/**
 * Keeping Flutterwave's subscriptions in step with ours (MAIL-SPEC §8). The
 * card is charged by Flutterwave, so before a downgrade or cancellation is
 * scheduled — or a past-due plan paid again — its subscription is stopped,
 * and only what Flutterwave confirms is noted (`note_provider_canceled`,
 * migration 50). A subscription we could not stop is an incident: it may
 * charge the card again.
 */

/** Types say every RPC argument is a string; these columns take NULL. */
const orNull = <T>(value: T | null) => value as T

export type BillingIncident =
  | 'tx_ref_mismatch'
  | 'unrecorded_payment'
  | 'subscription_not_canceled'
  | 'unknown_reference'
  | 'unapplied_charge'

/**
 * Money that arrived but was not applied, or a subscription we could not
 * stop, is recorded as a row the admin area reads (`mail.billing_incidents`)
 * and logged at error level — never only logged. Ids and amounts, never a
 * customer's details (N13).
 */
export async function recordIncident(
  service: MailServiceClient,
  settings: Pick<BillingSettings, 'testMode'>,
  kind: BillingIncident,
  facts: {
    accountId?: string | null
    reference?: string | null
    detail?: Record<string, string | number | boolean>
  },
): Promise<void> {
  logger.error(
    { kind, accountId: facts.accountId ?? null, reference: facts.reference ?? null },
    'billing incident: a person must look',
  )
  const { error } = await service.rpc('record_billing_incident', {
    p_test_mode: settings.testMode,
    p_kind: kind,
    p_account_id: orNull(facts.accountId ?? null),
    p_provider_reference: orNull(facts.reference ?? null),
    p_detail: facts.detail ?? {},
  })
  if (error) logger.error({ kind, code: error.code }, 'billing incident could not be recorded')
}

/**
 * Stops the Flutterwave subscription a first charge started. True only once
 * Flutterwave says it is stopped: a subscription it cannot find for that
 * charge is not taken as stopped — the card is never assumed safe.
 */
export async function stopFlutterwaveSubscription(
  settings: BillingSettings,
  firstTransactionId: string,
): Promise<boolean> {
  const found = await findSubscription(settings, firstTransactionId)
  if (found.kind !== 'found') return false
  if (isStopped(found.subscription.status)) return true
  return setSubscription(settings, found.subscription.id, 'cancel')
}

/** Starts it again (a scheduled change withdrawn). */
export async function restartFlutterwaveSubscription(
  settings: BillingSettings,
  firstTransactionId: string,
): Promise<boolean> {
  const found = await findSubscription(settings, firstTransactionId)
  if (found.kind !== 'found') return false
  if (/^active$/i.test(found.subscription.status)) return true
  return setSubscription(settings, found.subscription.id, 'activate')
}

/** What billing_provider_state says about the account's subscription. */
export type ProviderState = {
  status: 'active' | 'past_due' | 'ended'
  firstTransactionId: string | null
  providerCanceled: boolean
  scheduledPlanCode: string | null
} | null

export async function readProviderState(
  service: MailServiceClient,
  accountId: string,
): Promise<ProviderState | 'error'> {
  const { data, error } = await service.rpc('billing_provider_state', { p_account_id: accountId })
  if (error) return 'error'
  const sub = (data as { subscription?: Record<string, unknown> | null } | null)?.subscription
  if (!sub) return null
  const status = sub.status
  if (status !== 'active' && status !== 'past_due' && status !== 'ended') return 'error'
  return {
    status,
    firstTransactionId: typeof sub.firstTransactionId === 'string' ? sub.firstTransactionId : null,
    providerCanceled: sub.providerCanceled === true,
    scheduledPlanCode: typeof sub.scheduledPlanCode === 'string' ? sub.scheduledPlanCode : null,
  }
}

/** Stops the account's current Flutterwave subscription and notes it; true when done. */
export async function stopAndNote(
  service: MailServiceClient,
  settings: BillingSettings,
  accountId: string,
  firstTransactionId: string,
): Promise<boolean> {
  if (!(await stopFlutterwaveSubscription(settings, firstTransactionId))) return false
  const { data, error } = await service.rpc('note_provider_canceled', {
    p_account_id: accountId,
    p_first_transaction_id: firstTransactionId,
  })
  return !error && (data as { ok?: boolean } | null)?.ok === true
}

/** Restarts it and notes that; true when done. */
export async function restartAndNote(
  service: MailServiceClient,
  settings: BillingSettings,
  accountId: string,
  firstTransactionId: string,
): Promise<boolean> {
  if (!(await restartFlutterwaveSubscription(settings, firstTransactionId))) return false
  const { data, error } = await service.rpc('note_provider_active', {
    p_account_id: accountId,
    p_first_transaction_id: firstTransactionId,
  })
  return !error && (data as { ok?: boolean } | null)?.ok === true
}

/**
 * After a charge is recorded: stops each Flutterwave subscription SQL named
 * (`cancelTransactions` — the one an upgrade replaced, or one that paid for
 * nothing). One we cannot stop may charge the card again: an incident.
 */
export async function stopReplaced(
  service: MailServiceClient,
  settings: BillingSettings,
  accountId: string | null,
  firstTransactionIds: readonly string[],
): Promise<void> {
  for (const id of firstTransactionIds) {
    if (await stopFlutterwaveSubscription(settings, id)) continue
    await recordIncident(service, settings, 'subscription_not_canceled', {
      accountId,
      reference: id,
      detail: { reason: 'flutterwave_did_not_confirm' },
    })
  }
}
