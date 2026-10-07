import 'server-only'

import { logger } from '@/lib/logger'
import type { MailServiceClient } from '@/lib/supabase/service'
import { isStopped, TRANSACTION_ID } from '../lib/flutterwave'
import type { BillingSettings } from './env'
import { findSubscriptions, setSubscription } from './flutterwave'
import { recordIncident } from './provider'

/**
 * Duplicate Flutterwave subscriptions (MAIL-SPEC §8; migration 56). A live
 * test-mode run (7 Oct 2026) showed one checkout charge (10534506) starting
 * two subscriptions for one customer and plan — 53194, then 53195 three
 * minutes later — and both renewing on its tx_ref: the customer billed twice
 * a month. So, after a first charge is recorded, after a second renewal in one
 * month, and every hour (`/api/jobs/billing`), the subscriptions of the
 * account's first charge are listed; when more than one may still charge, the
 * earliest-made is kept and the others are cancelled.
 *
 * Safe to repeat: each run lists first and cancels only what is still
 * running, and the incident is one open row per account and charge. A cancel
 * Flutterwave does not confirm — refused, failed or timed out — is never
 * taken as done and never sent again in the same run: the next hour lists
 * and asks again (an open `duplicate_subscription` incident puts the account
 * first in that run).
 */

export type DuplicateCheck =
  /** Flutterwave could not be asked, or did not list every subscription. */
  | { kind: 'unreachable' }
  /** At most one may still charge: nothing to do. */
  | { kind: 'single' }
  | { kind: 'duplicates'; kept: number; canceled: number[]; notCanceled: number[] }

export async function cancelDuplicateSubscriptions(
  service: MailServiceClient,
  settings: BillingSettings,
  accountId: string | null,
  firstTransactionId: string,
): Promise<DuplicateCheck> {
  const found = await findSubscriptions(settings, firstTransactionId)
  if (found.kind === 'unreachable') return { kind: 'unreachable' }
  // Not confirmed stopped is taken as charging: the card is never assumed safe.
  const live =
    found.kind === 'found'
      ? found.subscriptions.filter((subscription) => !isStopped(subscription.status))
      : []
  const [kept, ...duplicates] = live
  if (!kept || duplicates.length === 0) return { kind: 'single' }

  // Noted before the cancels, so a run cut short still leaves it for a person.
  await recordIncident(service, settings, 'duplicate_subscription', {
    accountId,
    reference: firstTransactionId,
    detail: {
      kept_subscription_id: String(kept.id),
      duplicate_subscription_ids: duplicates.map((subscription) => subscription.id).join(', '),
    },
  })
  const canceled: number[] = []
  const notCanceled: number[] = []
  for (const duplicate of duplicates) {
    if (await setSubscription(settings, duplicate.id, 'cancel')) canceled.push(duplicate.id)
    else notCanceled.push(duplicate.id)
  }
  const facts = { accountId, firstTransactionId, kept: kept.id, canceled, notCanceled }
  if (notCanceled.length > 0) {
    logger.error(
      facts,
      'duplicate flutterwave subscription not cancelled yet: asked again next hour',
    )
  } else {
    logger.warn(facts, 'duplicate flutterwave subscription cancelled')
  }
  return { kind: 'duplicates', kept: kept.id, canceled, notCanceled }
}

/** What one hourly run looked at and did; counts only (N13). */
export type DuplicateSweep = {
  checked: number
  duplicates: number
  canceled: number
  notCanceled: number
  unreachable: number
}

type Due = { accountId: string; firstTransactionId: string }

/** `begin_billing_jobs`' answer, read; null when the token was refused. */
export function readDueAccounts(data: unknown): Due[] | null {
  const answer = data as { ok?: unknown; accounts?: unknown } | null
  if (answer?.ok !== true) return null
  if (!Array.isArray(answer.accounts)) return []
  return answer.accounts.flatMap((row) => {
    const { accountId, firstTransactionId } = (row ?? {}) as Record<string, unknown>
    return typeof accountId === 'string' &&
      typeof firstTransactionId === 'string' &&
      TRANSACTION_ID.test(firstTransactionId)
      ? [{ accountId, firstTransactionId }]
      : []
  })
}

/** Accounts looked at one run, and side by side; a run stays inside the route's minute. */
export const SWEEP_LIMIT = 100
const SWEEP_PARALLEL = 3
const SWEEP_BUDGET_MS = 45_000

/**
 * The hourly run: asks SQL which live subscriptions this key may ask
 * Flutterwave about (the token checked there), then looks at each. Null when
 * the token is refused.
 */
export async function sweepDuplicateSubscriptions(
  service: MailServiceClient,
  settings: BillingSettings,
  token: string,
  now: () => number = Date.now,
): Promise<DuplicateSweep | null> {
  const { data, error } = await service.rpc('begin_billing_jobs', {
    p_token: token,
    p_test_mode: settings.testMode,
    p_api_host: settings.apiHost,
    p_limit: SWEEP_LIMIT,
  })
  if (error) throw new Error(`begin_billing_jobs failed: ${error.code ?? 'unknown'}`)
  const due = readDueAccounts(data)
  if (!due) return null

  const sweep: DuplicateSweep = {
    checked: 0,
    duplicates: 0,
    canceled: 0,
    notCanceled: 0,
    unreachable: 0,
  }
  const stopAt = now() + SWEEP_BUDGET_MS
  const queue = [...due]
  const worker = async () => {
    for (let next = queue.shift(); next && now() < stopAt; next = queue.shift()) {
      const result = await cancelDuplicateSubscriptions(
        service,
        settings,
        next.accountId,
        next.firstTransactionId,
      )
      sweep.checked += 1
      if (result.kind === 'unreachable') sweep.unreachable += 1
      if (result.kind === 'duplicates') {
        sweep.duplicates += 1
        sweep.canceled += result.canceled.length
        sweep.notCanceled += result.notCanceled.length
      }
    }
  }
  await Promise.all(Array.from({ length: SWEEP_PARALLEL }, worker))
  return sweep
}
