import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import { type AdminRole, canAct } from '@/features/admin/lib/actions'
import type { ListSpec } from '@/features/admin/lib/list-params'
import { playbookFor } from '@/features/admin/lib/playbook'

/**
 * What the refunds pages decide before anything is shown (ADMIN-SPEC §5.2
 * B3): which buttons a refund offers, whether a Flutterwave check can back a
 * record, and how the lists read their URL. Pure: no React, no I/O. SQL is
 * still the authority — every wrapper checks again and records a refusal —
 * so these only keep a person from pressing a button that can only fail.
 */

export const REFUND_STATUSES = [
  'queued',
  'held',
  'sending',
  'submitted',
  'completed',
  'failed',
  'needs_attention',
  'cancelled',
] as const
export type RefundStatus = (typeof REFUND_STATUSES)[number]

export const REFUND_REASONS = [
  'registration_failed',
  'renewal_failed',
  'transfer_failed',
  'ssl_failed',
  'duplicate_charge',
  'overpayment',
  'underpayment',
  'empty_order',
  'late_payment',
  'over_limit',
] as const
export type RefundReason = (typeof REFUND_REASONS)[number]

/** What the sidebar counts as needing a person. */
export const REFUND_NEEDS_PERSON: readonly RefundStatus[] = ['held', 'failed', 'needs_attention']

export const REFUND_SORTS = ['created', 'updated', 'amount', 'status'] as const
export type RefundSort = (typeof REFUND_SORTS)[number]

export const REFUND_LIST: ListSpec<RefundSort, RefundStatus> = {
  sorts: REFUND_SORTS,
  defaultSort: 'created',
  statuses: REFUND_STATUSES,
}

/** The column each sort reads. */
export const REFUND_SORT_COLUMN: Record<RefundSort, string> = {
  created: 'created_at',
  updated: 'updated_at',
  amount: 'amount_kobo',
  status: 'status',
}

type Search = Record<string, string | string[] | undefined>

const firstOf = (search: Search, key: string): string | undefined => {
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

/** `?reason=a,b`: only reasons the database has; anything else is dropped. */
export function parseReasons(search: Search): RefundReason[] {
  const raw = Array.isArray(search.reason) ? search.reason : [search.reason ?? '']
  const known = new Set<string>(REFUND_REASONS)
  return [
    ...new Set(raw.flatMap((value) => value.split(',')).filter((value) => known.has(value))),
  ] as RefundReason[]
}

/**
 * `?q=` is an order number — ND-001234, nd-1234 or 1234 — and nothing else:
 * never an email or a name (N13). Returns the stored form, or null.
 */
export function orderNumberQuery(q: string | null | undefined): string | null {
  const text = (q ?? '').trim().toUpperCase()
  const match = /^(?:ND-?)?(\d{1,9})$/.exec(text)
  if (!match?.[1]) return null
  return `ND-${match[1].padStart(6, '0')}`
}

export function queryText(search: Search): string {
  return (firstOf(search, 'q') ?? '').trim().slice(0, 120)
}

// ── Which buttons a refund offers ─────────────────────────────────────────

export type RefundFacts = {
  status: string
  lastErrorCode: string | null
  providerCalledAt: string | null
  providerRefundId: string | null
}

export type RefundOffers = {
  approve: boolean
  retry: boolean
  cancel: boolean
  record: boolean
}

type Viewer = { role: AdminRole; testOnly: boolean }

/** Flutterwave was called for this refund: every dialog asks for the dashboard check. */
export function providerWasCalled(refund: RefundFacts): boolean {
  return refund.providerCalledAt !== null || refund.providerRefundId !== null
}

/**
 * Buttons by status, playbook and role (§5.2). Approve is for a held
 * refund. Retry and record follow the playbook for a failed or stuck one,
 * and only the owner retries or records a cancelled one. Cancel is the
 * owner's alone, for a refund that has not reached Flutterwave — or whose
 * Flutterwave refund bounced, so no money moved (§15).
 */
export function refundOffers(refund: RefundFacts, admin: Viewer): RefundOffers {
  const offers = playbookFor(refund.lastErrorCode).offers
  const status = refund.status
  const stuck = status === 'failed' || status === 'needs_attention'
  const owner = admin.role === 'owner' && !admin.testOnly
  const bounced = status === 'failed' && (refund.lastErrorCode ?? '') === 'PROVIDER_REFUND_FAILED'
  return {
    approve: status === 'held' && canAct(admin, 'refund.approve'),
    retry:
      canAct(admin, 'refund.retry') &&
      ((stuck && offers.includes('retry_refund')) || (status === 'cancelled' && owner)),
    cancel:
      canAct(admin, 'refund.cancel') &&
      ['queued', 'held', 'failed', 'needs_attention'].includes(status) &&
      (refund.providerRefundId === null || bounced),
    record:
      canAct(admin, 'refund.record_manual') &&
      ((stuck && offers.includes('record_manual_refund')) || (status === 'cancelled' && owner)),
  }
}

// ── A Flutterwave refund, read from here, as evidence ──────────────────────

/** D23: a check backs a record for 15 minutes. */
export const CHECK_FRESH_MS = 15 * 60 * 1000

/** A Flutterwave refund id, as the record wrapper takes it. */
export const FLW_REFUND_ID = /^[A-Za-z0-9_-]{3,64}$/

export type CheckProblem =
  | { kind: 'state'; state: AdminFlwRefundCheck['state']; status: string }
  | { kind: 'amount'; checkKobo: number; wantKobo: number }
  | { kind: 'charge'; checkTx: string | null; wantTx: string }
  | { kind: 'stale' }

/**
 * Whether a check matches what it is evidence for: completed at Flutterwave,
 * read under 15 minutes ago, for this refund's amount — and, when the charge
 * is known here (an incident's), on this charge. The wrapper checks all of
 * it again, the charge included, before anything is recorded.
 */
export function checkProblems(
  check: AdminFlwRefundCheck,
  want: { amountKobo?: number; transactionId?: string | null },
  nowMs: number,
): CheckProblem[] {
  const problems: CheckProblem[] = []
  if (check.state !== 'done')
    problems.push({ kind: 'state', state: check.state, status: check.status })
  if (want.amountKobo !== undefined && check.amountKobo !== want.amountKobo) {
    problems.push({ kind: 'amount', checkKobo: check.amountKobo, wantKobo: want.amountKobo })
  }
  if (want.transactionId !== undefined) {
    const wanted = want.transactionId ?? ''
    if (wanted === '' || check.transactionId !== wanted) {
      problems.push({ kind: 'charge', checkTx: check.transactionId, wantTx: wanted })
    }
  }
  const readAt = Date.parse(check.readAt)
  if (Number.isNaN(readAt) || nowMs - readAt >= CHECK_FRESH_MS) problems.push({ kind: 'stale' })
  return problems
}

// ── Payment incidents ─────────────────────────────────────────────────────

/** Kinds where money is owed: resolving one is a money action, with evidence (§3.1.2). */
export const OWED_INCIDENT_KINDS = [
  'unrecorded_payment',
  'refund_not_created',
  'currency_mismatch',
  'mode_mismatch',
] as const

export const INCIDENT_KINDS = [
  'unrecorded_payment',
  'refund_not_created',
  'currency_mismatch',
  'mode_mismatch',
  'underpayment',
  'tx_ref_mismatch',
  'registered_after_refund',
  'late_payment',
  'over_limit',
] as const

export function isOwedIncident(kind: string): boolean {
  return (OWED_INCIDENT_KINDS as readonly string[]).includes(kind)
}

export const INCIDENT_OUTCOMES = [
  'payment_recorded',
  'refund_completed',
  'flw_refund_verified',
  'handled_outside',
] as const
export type IncidentOutcome = (typeof INCIDENT_OUTCOMES)[number]

/** The outcomes a person may choose for an owed incident: payment only for an unrecorded one, outside only for the owner. */
export function outcomesFor(kind: string, admin: Viewer): IncidentOutcome[] {
  return INCIDENT_OUTCOMES.filter((outcome) => {
    if (outcome === 'payment_recorded') return kind === 'unrecorded_payment'
    if (outcome === 'handled_outside') return admin.role === 'owner' && !admin.testOnly
    return true
  })
}

export const INCIDENT_STATES = ['open', 'resolved', 'all'] as const
export type IncidentState = (typeof INCIDENT_STATES)[number]

export type IncidentListParams = {
  state: IncidentState
  /**
   * One incident by its number (`?id=`), resolved or not: what a link to one
   * incident opens, so its card is on the page whichever list it is in.
   */
  id: number | null
  kinds: string[]
  dir: 'asc' | 'desc'
  page: number
  per: number
}

const PER_OPTIONS = [25, 50, 100]

/** `?state=&kind=&id=&dir=&page=&per=`, strictly: unresolved, newest first, by default. */
export function parseIncidentParams(search: Search): IncidentListParams {
  const stateText = firstOf(search, 'state')
  const state = (INCIDENT_STATES as readonly string[]).includes(stateText ?? '')
    ? (stateText as IncidentState)
    : 'open'
  const known = new Set<string>(INCIDENT_KINDS)
  const raw = Array.isArray(search.kind) ? search.kind : [search.kind ?? '']
  const kinds = [...new Set(raw.flatMap((v) => v.split(',')).filter((v) => known.has(v)))]
  const pageText = firstOf(search, 'page') ?? '1'
  const page = /^\d{1,5}$/.test(pageText) ? Math.max(Number(pageText), 1) : 1
  const perText = Number(firstOf(search, 'per'))
  const idText = firstOf(search, 'id') ?? ''
  return {
    state,
    id: /^[1-9]\d{0,14}$/.test(idText) ? Number(idText) : null,
    kinds,
    dir: firstOf(search, 'dir') === 'asc' ? 'asc' : 'desc',
    page,
    per: PER_OPTIONS.includes(perText) ? perText : 25,
  }
}

/** A link to the incidents list with some values changed; defaults stay out of the URL. */
export function incidentsHref(
  params: IncidentListParams,
  changes: Partial<IncidentListParams> = {},
): string {
  const next = { ...params, ...changes }
  if (!('page' in changes)) next.page = 1
  // A state or kind chip lists incidents again, not the one asked for by number.
  if (!('id' in changes) && ('state' in changes || 'kinds' in changes)) next.id = null
  const query = new URLSearchParams()
  if (next.state !== 'open') query.set('state', next.state)
  if (next.id !== null) query.set('id', String(next.id))
  if (next.kinds.length > 0) query.set('kind', next.kinds.join(','))
  if (next.dir !== 'desc') query.set('dir', next.dir)
  if (next.per !== 25) query.set('per', String(next.per))
  if (next.page > 1) query.set('page', String(next.page))
  const text = query.toString()
  return text ? `/admin/refunds/incidents?${text}` : '/admin/refunds/incidents'
}

/** Toggling one value in a multi-value filter. */
export function toggled<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

/** Lagos midnight at the start of a `YYYY-MM-DD` day, for a created-at filter (WAT is UTC+1, no DST). */
export function watDayStart(day: string): string {
  return `${day}T00:00:00+01:00`
}

/** Lagos midnight at the end of a `YYYY-MM-DD` day: the next day's start. */
export function watDayEnd(day: string): string {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return `${next}T00:00:00+01:00`
}
