import type { AdminRegistryDomain, AdminRenewCheck, AdminTransferState } from '@dr/shared/admin'
import { formatNaira } from '@dr/shared/pricing'
import { SSL_TERM } from '@dr/shared/ssl'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import { formatWat, formatWatDate, formatWatTime } from '@/features/admin/lib/format'
import {
  type JobLedger,
  ledgerVerdict,
  type ReadCall,
  type ReadVerdict,
} from '@/features/admin/lib/queue-facts'

/**
 * Every word the queue's buttons say (docs/ADMIN-SPEC.md §5.2 B4): the Retry
 * and Fail dialogs by kind, when each is offered and why not, and what a live
 * read found. Copy describes what the SQL wrappers and the worker do — no
 * more (N9b): admin_retry_job, admin_fail_job and their certificate twins.
 */

/** What the copy needs to know about one job. */
export type JobFacts = {
  kind: string
  status: string
  lastErrorCode: string | null
  /** The domain, or the certificate's name, when known. */
  name: string | null
  /** The open refund a Retry would cancel (a failed registration or renewal). */
  pendingRefundKobo: number | null
  /** The line's refund has reached Flutterwave: Retry is refused. */
  refundAtProvider: boolean
  /** What a Fail would queue back to the customer. */
  failRefundKobo: number | null
  /** set_transfer_lock: true when the change turns the lock on. */
  pendingTransferLock: boolean | null
  /** A certificate order noted as sent to the supplier. */
  sentAt: string | null
}

export type Offer<T> = { offered: true; copy: T } | { offered: false; words: string | null }

export type RetryCopy = {
  title: string
  body: string
  confirmLabel: 'Retry'
  cancelLabel: 'Not now'
  /** Said once it went through. */
  done: string
}

export type FailCopy = {
  title: string
  body: string
  trigger: string
  confirmLabel: string
  /** The read the wrapper needs first, if any. */
  needsRead: 'registry' | 'transfer' | null
  /** Said once it went through. */
  done: string
}

const SSL_KINDS: ReadonlySet<string> = new Set(['ssl_initialize', 'ssl_configure', 'ssl_reissue'])

export const isSslKind = (kind: string): boolean => SSL_KINDS.has(kind)

/** What the job does, as the object of a sentence. */
const SUBJECT: Readonly<Record<string, string>> = {
  register_domain: 'the registration of',
  renew_domain: 'the renewal of',
  transfer_domain: 'the transfer of',
  apply_nameservers: 'the nameserver change for',
  set_transfer_lock: 'the transfer lock change for',
  set_privacy: 'the privacy change for',
  update_contacts: 'the contact change for',
  ssl_initialize: 'the certificate order for',
  ssl_configure: 'the certificate set-up for',
  ssl_reissue: 'the certificate reissue for',
}

function nameOf(facts: Pick<JobFacts, 'kind' | 'name'>): string {
  if (facts.name) return facts.name
  return isSslKind(facts.kind) ? 'this certificate' : 'this domain'
}

const naira = (kobo: number) => formatNaira(kobo)

export const FAILED_TRANSFER_WORDS =
  "A failed transfer can't be retried: its transfer code was deleted. The customer starts a new transfer."

/** Spec words for the jobs that keep only Retry (§5.2). */
export const ONLY_RETRY_WORDS =
  'Only Retry is offered: stopping this could block a transfer-out, or leave a change half-recorded.'

export const RETRY_DONE = 'Back in the queue: the worker takes it on its next run.'
const REFUND_DONE = 'Failed. The refund is queued to the card or account that paid.'
const STOP_DONE = 'Stopped. Nothing more is sent for this change.'

const RETRY_SETTINGS_BODY =
  "The worker reads the registry, makes the change if it's still needed, and records what the registry shows."

function refundSentence(kobo: number | null): string {
  return kobo === null
    ? ''
    : ` Its pending refund of ${naira(kobo)} is cancelled first; this is refused if that refund has reached Flutterwave.`
}

export function retryTitle(facts: Pick<JobFacts, 'kind' | 'name'>): string {
  const subject = SUBJECT[facts.kind] ?? 'this job for'
  return `Try ${subject} ${nameOf(facts)} again?`
}

export function retryBody(facts: JobFacts): string {
  const name = nameOf(facts)
  switch (facts.kind) {
    case 'register_domain':
      if (facts.status === 'failed') {
        return `The worker reads the registry first: if ${name} is already in our account it is recorded, not bought again.${refundSentence(facts.pendingRefundKobo)}`
      }
      return 'The worker re-reads the charge from Flutterwave and the registry, and registers only if both allow it.'
    case 'renew_domain':
      return `The worker compares the registry's expiry with the one stored before renewing, and renews only if it hasn't moved.${facts.status === 'failed' ? refundSentence(facts.pendingRefundKobo) : ''}`
    case 'transfer_domain':
      return "The worker reads the transfer's state; once submitted it never sends the code again."
    case 'apply_nameservers':
    case 'set_transfer_lock':
    case 'set_privacy':
    case 'update_contacts':
      return RETRY_SETTINGS_BODY
    case 'ssl_initialize':
      return `If the order was already sent, the worker only reads its status — it never buys twice.${
        facts.status !== 'failed'
          ? ''
          : facts.pendingRefundKobo === null
            ? ' A refund still pending for it is cancelled first; this is refused if that refund has reached Flutterwave.'
            : refundSentence(facts.pendingRefundKobo)
      }`
    case 'ssl_configure':
    case 'ssl_reissue':
      return 'If the order was already sent, the worker only reads its status — it never buys twice.'
    default:
      return 'The worker picks the job up again on its next run.'
  }
}

/**
 * Retry is offered for a job that failed or needs a person — not a failed
 * transfer, whose code is gone, and not a line whose refund has reached
 * Flutterwave (both refused by SQL too).
 */
export function retryOffer(facts: JobFacts): Offer<RetryCopy> {
  if (facts.status !== 'needs_attention' && facts.status !== 'failed') {
    return { offered: false, words: null }
  }
  if (facts.kind === 'transfer_domain' && facts.status === 'failed') {
    return { offered: false, words: FAILED_TRANSFER_WORDS }
  }
  if (facts.status === 'failed' && facts.refundAtProvider) {
    return { offered: false, words: ADMIN_ERROR_WORDS.REFUND_AT_PROVIDER ?? null }
  }
  return {
    offered: true,
    copy: {
      title: retryTitle(facts),
      body: retryBody(facts),
      confirmLabel: 'Retry',
      cancelLabel: 'Not now',
      done: RETRY_DONE,
    },
  }
}

const STOP_TITLE: Readonly<Record<string, string>> = {
  set_transfer_lock: 'Stop this transfer lock change?',
  set_privacy: 'Stop this privacy change?',
  update_contacts: 'Stop this contact change?',
  ssl_configure: 'Stop this certificate set-up?',
  ssl_reissue: 'Stop this certificate reissue?',
}

const STOP_BODY =
  'The change is dropped; the domain keeps what the registry shows. The customer can ask again.'
const STOP_SSL_BODY =
  'The request is dropped; the certificate keeps what the supplier shows. The customer can ask again.'

function refundPhrase(kobo: number | null): string {
  return kobo === null ? 'the amount paid for it' : naira(kobo)
}

export function failCopy(facts: JobFacts): FailCopy | null {
  const name = nameOf(facts)
  const refund = refundPhrase(facts.failRefundKobo)
  const confirm = facts.failRefundKobo === null ? 'Fail and refund' : `Fail and refund ${refund}`
  switch (facts.kind) {
    case 'register_domain':
      return {
        title: `Fail the registration of ${name} and refund ${refund}?`,
        body: `The line fails, the customer is told nothing was bought, and a refund of ${refund} is queued to the card or account that paid.`,
        trigger: 'Fail',
        confirmLabel: confirm,
        needsRead: 'registry',
        done: REFUND_DONE,
      }
    case 'transfer_domain':
      return {
        title: `Fail the transfer of ${name} and refund ${refund}?`,
        body: `The registry refused it, so the domain didn't move to us. The customer is told and a refund of ${refund} is queued.`,
        trigger: 'Fail',
        confirmLabel: confirm,
        needsRead: 'transfer',
        done: REFUND_DONE,
      }
    case 'set_transfer_lock':
    case 'set_privacy':
    case 'update_contacts':
      return {
        title: STOP_TITLE[facts.kind] ?? 'Stop this change?',
        body: STOP_BODY,
        trigger: 'Stop the change',
        confirmLabel: 'Stop the change',
        needsRead: null,
        done: STOP_DONE,
      }
    case 'ssl_initialize':
      return {
        title: `Fail the certificate order for ${name}?`,
        body:
          facts.failRefundKobo === null
            ? 'It was never sent to the supplier, so nothing was bought. The line fails, the customer is told, and its refund is queued to the card or account that paid.'
            : `It was never sent to the supplier, so nothing was bought. The line fails, the customer is told, and a refund of ${refund} is queued to the card or account that paid.`,
        trigger: 'Fail',
        confirmLabel: 'Fail the order',
        needsRead: null,
        done: REFUND_DONE,
      }
    case 'ssl_configure':
    case 'ssl_reissue':
      return {
        title: STOP_TITLE[facts.kind] ?? 'Stop this change?',
        body: STOP_SSL_BODY,
        trigger: 'Stop the change',
        confirmLabel: 'Stop the change',
        needsRead: null,
        done: STOP_DONE,
      }
    default:
      return null
  }
}

/**
 * Fail is offered only for a job that needs a person, of a kind a person may
 * end (§5.2): never for an unverified charge (D20), a renewal or nameserver
 * change (half-recorded), a pending unlock (N14), or a certificate order that
 * may have reached the supplier (N3). admin_fail_job and admin_fail_ssl_job
 * refuse the same.
 */
export function failOffer(facts: JobFacts): Offer<FailCopy> {
  if (facts.status !== 'needs_attention') return { offered: false, words: null }
  if (facts.lastErrorCode === 'PAYMENT_NOT_VERIFIED') {
    return { offered: false, words: ADMIN_ERROR_WORDS.PAYMENT_NOT_VERIFIED ?? null }
  }
  if (facts.kind === 'renew_domain' || facts.kind === 'apply_nameservers') {
    return { offered: false, words: ONLY_RETRY_WORDS }
  }
  if (facts.kind === 'set_transfer_lock' && facts.pendingTransferLock !== true) {
    return { offered: false, words: ONLY_RETRY_WORDS }
  }
  if (facts.kind === 'ssl_initialize' && facts.sentAt !== null) {
    return { offered: false, words: ADMIN_ERROR_WORDS.ALREADY_SENT ?? null }
  }
  const copy = failCopy(facts)
  return copy ? { offered: true, copy } : { offered: false, words: ONLY_RETRY_WORDS }
}

// ── Before failing: the read admin_fail_job needs ──────────────────────────

export function failRequirement(read: 'registry' | 'transfer'): string {
  return read === 'registry'
    ? 'Fail needs a registry read in the last 15 minutes, after the last registration attempt, that finds the domain is not in our account.'
    : 'Fail needs a transfer state read in the last 15 minutes, after the last transfer attempt, that finds the registry refused or cancelled it.'
}

export function readVerdictWords(verdict: ReadVerdict, read: 'registry' | 'transfer'): string {
  const what = read === 'registry' ? 'registry read' : 'transfer state read'
  switch (verdict) {
    case 'none':
      return `No ${what} is recorded for this domain on this side.`
    case 'stale':
      return `The last ${what} is over 15 minutes old. Read it again.`
    case 'before_attempt':
      return `The last ${what} came before the job's last attempt. Read it again.`
    case 'not_qualifying':
      return read === 'registry'
        ? 'The last registry read did not find it missing, so Fail is refused. Retry instead: in our account, it is recorded.'
        : 'The last transfer state read did not show a refusal, so Fail is refused.'
    case 'ok':
      return `The last ${what} is recent and allows Fail.`
  }
}

const LEDGER_SYNC_FAILED = ' The latest ledger sync failed: this is the last good read.'

/**
 * The supplier ledger, as the Fail precondition panel says it (§5.2): "Ledger
 * last read 14:15 WAT; no charge for example.com since this job started."
 * Only what the mirror can show: a read made before the job started could
 * not have seen its charge.
 */
export function ledgerWords(ledger: JobLedger | 'unreadable', name: string): string {
  const verdict = ledgerVerdict(ledger)
  if (ledger === 'unreadable' || verdict === 'unreadable') {
    return "The supplier ledger couldn't be read just now. The database still checks it when you fail this job."
  }
  const failed = ledger.outcome === 'failed' ? LEDGER_SYNC_FAILED : ''
  const read = `Ledger last read ${formatWat(ledger.readAt)}`
  switch (verdict) {
    case 'charge':
      return `${ledger.readAt ? `${read}; it` : 'The supplier ledger'} shows ${
        ledger.charges === 1 ? 'a charge' : `${ledger.charges} charges`
      } for ${name} since this job started, so Fail is refused. Don't fail it: retry, or ask.${failed}`
    case 'never_read':
      return `The supplier ledger hasn't been read on this side yet, so it can't show whether ${name} was charged.${failed}`
    case 'before_job':
      return `${read}, before this job started: it can't show a charge for ${name} yet.${failed}`
    default:
      return `${read}; no charge for ${name} since this job started.${failed}`
  }
}

/** The last read on record, as the precondition panel says it. */
export function lastReadWords(read: 'registry' | 'transfer', last: ReadCall | null): string | null {
  if (!last) return null
  const what = read === 'registry' ? 'registry' : 'transfer state'
  const answered = `answered ${last.outcome.replace(/_/g, ' ')}`
  const found =
    read === 'registry'
      ? last.outcome === 'not_found'
        ? 'not in our account'
        : last.outcome === 'ok'
          ? 'in our account'
          : answered
      : (last.state ?? answered)
  return `Last ${what} read: ${formatWat(last.createdAt)} (${found}).`
}

// ── The order line ─────────────────────────────────────────────────────────

/**
 * What the line was sold at, with its renewal beside it (N8): a domain's
 * term and renewal term, or a certificate's subscription — which never
 * renews by itself, so its "renewal" is a new one at today's price.
 */
export function linePriceWords(line: {
  itemType: string
  periodYears: number
  renewalYears: number
  priceKobo: number
  renewalKobo: number
}): string {
  if (line.itemType === 'ssl') {
    return `${naira(line.priceKobo)} for a ${SSL_TERM.short}; a new one is ${naira(line.renewalKobo)} at today's price`
  }
  return `${naira(line.priceKobo)} for ${line.periodYears} ${
    line.periodYears === 1 ? 'year' : 'years'
  }, then ${naira(line.renewalKobo)} every ${
    line.renewalYears === 1 ? 'year' : `${line.renewalYears} years`
  }`
}

// ── What a live read found ─────────────────────────────────────────────────

export function registryReadWords(result: AdminRegistryDomain): string {
  const at = `Read at ${formatWatTime(result.readAt)}`
  if (result.outcome === 'not_found') return `${at}: not in our account`
  return result.expiresAt
    ? `${at}: in our account, expires ${formatWatDate(result.expiresAt)}`
    : `${at}: in our account`
}

export function transferStateWords(result: AdminTransferState): string {
  const at = `Read at ${formatWatTime(result.readAt)}`
  const on = (value: string | null) => (value ? ` on ${formatWatDate(value)}` : '')
  switch (result.state) {
    case 'rejected':
      return `${at}: refused by the registry${on(result.finalAt)}`
    case 'cancelled':
      return `${at}: cancelled at the registry${on(result.finalAt)}`
    case 'completed':
      return `${at}: landed — record it in the SQL editor (DEPLOY §6)`
    case 'pending':
      return `${at}: still waiting at the registry${result.requestedAt ? ` (asked${on(result.requestedAt)})` : ''}`
    default:
      return `${at}: the registry's answer didn't say where the transfer stands`
  }
}

/** The gateway's keys for a renew-check refusal (apps/gateway/src/admin/shapes.ts). */
const RENEW_REASON: Readonly<Record<string, string>> = {
  PERIOD_NOT_ALLOWED: "the registry doesn't allow that period",
}

export function renewCheckWords(result: AdminRenewCheck): string {
  const at = `Read at ${formatWatTime(result.readAt)}`
  if (result.renewable && !result.renewalLock) return `${at}: the registry would renew it`
  if (result.renewalLock) return `${at}: the registry would not renew it — renewal is locked`
  const why = result.reasonKey ? (RENEW_REASON[result.reasonKey] ?? null) : null
  return why
    ? `${at}: the registry would not renew it — ${why}`
    : `${at}: the registry would not renew it`
}
