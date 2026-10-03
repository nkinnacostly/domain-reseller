import { z } from 'zod'
import type { ListParams, ListSpec } from '@/features/admin/lib/list-params'
import { listHref } from '@/features/admin/lib/list-params'

/**
 * The queue pages' lists and the facts their buttons depend on (ADMIN-SPEC
 * §5.2 B4), as pure functions: which filters a URL may carry, what a failed
 * line's refund comes to, and whether a registry read is recent enough for
 * Fail. SQL decides every one of these again (admin_fail_job, enqueue_line_refund).
 */

export const JOB_STATUSES = ['needs_attention', 'failed', 'queued', 'running', 'succeeded'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const DOMAIN_JOB_KINDS = [
  'register_domain',
  'renew_domain',
  'transfer_domain',
  'apply_nameservers',
  'set_transfer_lock',
  'set_privacy',
  'update_contacts',
] as const
export type DomainJobKind = (typeof DOMAIN_JOB_KINDS)[number]

export const SSL_JOB_KINDS = ['ssl_initialize', 'ssl_configure', 'ssl_reissue'] as const
export type SslJobKind = (typeof SSL_JOB_KINDS)[number]

export const JOB_SORTS = ['created', 'updated', 'attempts', 'next'] as const
export type JobSort = (typeof JOB_SORTS)[number]

/** The column each sort orders by. */
export const JOB_SORT_COLUMN: Readonly<Record<JobSort, string>> = {
  created: 'created_at',
  updated: 'updated_at',
  attempts: 'attempts',
  next: 'run_after',
}

export const JOB_LIST_SPEC: ListSpec<JobSort, JobStatus> = {
  sorts: JOB_SORTS,
  defaultSort: 'created',
  defaultDir: 'desc',
  statuses: JOB_STATUSES,
  perOptions: [25, 50, 100],
}

/** Still with the worker: the list refreshes itself while one of these is shown. */
export const OPEN_JOB_STATUSES: ReadonlySet<string> = new Set(['queued', 'running'])

export function hasOpenJob(rows: readonly { status: string }[]): boolean {
  return rows.some((row) => OPEN_JOB_STATUSES.has(row.status))
}

/** What a paid order line is, in words. */
export const LINE_KIND_LABEL: Record<string, string> = {
  register: 'Registration',
  renew: 'Renewal',
  transfer: 'Transfer in',
  ssl: 'Certificate',
}

type Search = Record<string, string | string[] | undefined>

function first(search: Search, key: string): string | undefined {
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

/** One kind from `?kind=`, when it is one this list knows. */
export function parseKind<K extends string>(search: Search, kinds: readonly K[]): K | null {
  const value = first(search, 'kind')
  return value && (kinds as readonly string[]).includes(value) ? (value as K) : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A uuid from the URL (`?domain=`, a route's `[id]`), lower-cased; anything else is null. */
export function parseUuid(value: string | string[] | undefined | null): string | null {
  const text = Array.isArray(value) ? value[0] : value
  return text && UUID.test(text) ? text.toLowerCase() : null
}

/** The other queue tab a `?tab=` names, so an old or guessed link still lands. */
export function tabRedirect(search: Search): string | null {
  const tab = first(search, 'tab')
  if (tab === 'pending') return '/admin/queue/pending'
  if (tab === 'ssl' || tab === 'ssl-jobs') return '/admin/queue/ssl-jobs'
  return null
}

export type JobFilters = { kind: string | null; domainId: string | null }

/**
 * A link to a job list with some values changed, keeping its kind and
 * domain filters — which are ids and enum values, never a name (N13).
 */
export function jobsHref(
  base: string,
  params: ListParams<JobSort, JobStatus>,
  filters: JobFilters,
  changes: Partial<ListParams<JobSort, JobStatus>> & { kind?: string | null } = {},
): string {
  const { kind, ...rest } = changes
  const nextKind = kind === undefined ? filters.kind : kind
  // Changing the kind is a filter change too: back to page 1.
  const paging = kind !== undefined && rest.page === undefined ? { page: 1 } : {}
  return listHref(base, params, JOB_LIST_SPEC, {
    ...rest,
    ...paging,
    extra: { kind: nextKind, domain: filters.domainId },
  })
}

export function filtersActive(
  params: ListParams<JobSort, JobStatus>,
  filters: JobFilters,
): boolean {
  return (
    params.status.length > 0 ||
    params.from !== null ||
    params.to !== null ||
    filters.kind !== null ||
    filters.domainId !== null
  )
}

const LAGOS_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today's date in Lagos, `YYYY-MM-DD` — the day reports are bucketed by. */
export function watDate(now: Date): string {
  return LAGOS_DATE.format(now)
}

/** `YYYY-MM-DD` plus some days (negative goes back). */
export function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000
  return new Date(time).toISOString().slice(0, 10)
}

/** The instant a WAT day starts: Lagos is UTC+1 all year. */
export function watDayStart(date: string): string {
  return `${date}T00:00:00+01:00`
}

/** The instant after a WAT day ends — an exclusive upper bound. */
export function watDayEnd(date: string): string {
  return watDayStart(addDays(date, 1))
}

// ── Money a failed line gives back ─────────────────────────────────────────

export type RefundLine = { id: string; priceKobo: number; createdAt: string }

/**
 * The refund a failed line queues, as `enqueue_line_refund` computes it: the
 * line's price plus its share of the order's VAT, each line's share floored
 * over the running total in (created_at, id) order, so the shares add up to
 * the VAT exactly. BigInt: VAT × running total can pass 2^53 (N5).
 */
export function lineRefundKobo(
  lines: readonly RefundLine[],
  order: { subtotalKobo: number; vatKobo: number },
  lineId: string,
): number | null {
  const sorted = [...lines].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
      : a.createdAt < b.createdAt
        ? -1
        : 1,
  )
  const subtotal = BigInt(order.subtotalKobo)
  if (subtotal <= 0n) return null
  const total = sorted.reduce((sum, line) => sum + line.priceKobo, 0)
  if (total !== order.subtotalKobo) return null
  const vat = BigInt(order.vatKobo)
  let upto = 0n
  for (const line of sorted) {
    const price = BigInt(line.priceKobo)
    const before = upto
    upto += price
    if (line.id === lineId) {
      const share = (vat * upto) / subtotal - (vat * before) / subtotal
      return Number(price + share)
    }
  }
  return null
}

export type LineRefund = {
  id: string
  status: string
  amountKobo: number
  providerRefundId: string | null
}

/**
 * The money a Fail would queue for a line: a cancelled refund comes back at
 * its own amount (enqueue_line_refund re-queues it); otherwise the line's
 * share. Null when it cannot be told — the dialog then names no figure.
 */
export function failRefundKobo(
  refunds: readonly LineRefund[],
  share: number | null,
): number | null {
  const reusable = refunds.find(
    (refund) => refund.status === 'cancelled' && refund.providerRefundId === null,
  )
  return reusable ? reusable.amountKobo : share
}

/** The refund a Retry would cancel: the line's open one, before it reaches Flutterwave. */
export function openLineRefund(refunds: readonly LineRefund[]): LineRefund | null {
  return refunds.find((refund) => refund.status !== 'cancelled') ?? null
}

const AT_PROVIDER: ReadonlySet<string> = new Set(['sending', 'submitted', 'completed'])

/** retry_job's refusal: the line's refund has reached Flutterwave. */
export function refundAtProvider(refund: LineRefund | null): boolean {
  return refund !== null && (AT_PROVIDER.has(refund.status) || refund.providerRefundId !== null)
}

// ── Whether a read is fresh enough to fail a job (admin_fail_job) ──────────

export const READ_WINDOW_MS = 15 * 60_000

export type ReadCall = { createdAt: string; outcome: string; state?: string | null }

export type ReadVerdict = 'none' | 'stale' | 'before_attempt' | 'not_qualifying' | 'ok'

/**
 * Whether the latest read lets Fail go ahead, as admin_fail_job judges it: in
 * the last 15 minutes, after the job's last attempt, and saying the domain is
 * not ours (a registration) or the registry refused or cancelled it (a
 * transfer). Only for the words beside the button: SQL decides.
 */
export function readVerdict(
  kind: 'registry' | 'transfer',
  read: ReadCall | null,
  lastAttemptAt: string | null,
  now: Date,
): ReadVerdict {
  if (!read) return 'none'
  const at = Date.parse(read.createdAt)
  if (Number.isNaN(at) || now.getTime() - at > READ_WINDOW_MS) return 'stale'
  if (lastAttemptAt && at <= Date.parse(lastAttemptAt)) return 'before_attempt'
  if (kind === 'registry') return read.outcome === 'not_found' ? 'ok' : 'not_qualifying'
  return read.outcome === 'ok' && (read.state === 'rejected' || read.state === 'cancelled')
    ? 'ok'
    : 'not_qualifying'
}

/** What a Fail or Retry would do with a line's money, from its refunds and its share. */
export function lineRefundFacts(
  refunds: readonly LineRefund[],
  share: number | null,
): { pendingRefundKobo: number | null; refundAtProvider: boolean; failRefundKobo: number | null } {
  const open = openLineRefund(refunds)
  return {
    pendingRefundKobo: open && !refundAtProvider(open) ? open.amountKobo : null,
    refundAtProvider: refundAtProvider(open),
    failRefundKobo: failRefundKobo(refunds, share),
  }
}

// ── The supplier ledger, as admin_fail_job reads it (migration 42) ─────────

const when = z.string().min(1).nullable()

const jobLedgerSchema = z.object({
  since: z.string().min(1),
  readAt: when,
  syncedAt: when,
  outcome: z.string().nullable(),
  charges: z.number().int().nonnegative(),
})

/**
 * `admin_job_ledger`: when the mirror was last read from the supplier (the
 * last good read), and how many domain charges name the job's domain since
 * the job was made — the count admin_fail_job refuses LEDGER_SHOWS_CHARGE on.
 */
export type JobLedger = z.infer<typeof jobLedgerSchema>

/** SQL's answer, or null when it is not that shape. */
export function parseJobLedger(data: unknown): JobLedger | null {
  const parsed = jobLedgerSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export type LedgerVerdict = 'charge' | 'clear' | 'before_job' | 'never_read' | 'unreadable'

/**
 * What the ledger says about failing: a charge refuses it; otherwise the
 * mirror shows none, but only a read after the job started could have.
 */
export function ledgerVerdict(ledger: JobLedger | 'unreadable'): LedgerVerdict {
  if (ledger === 'unreadable') return 'unreadable'
  if (ledger.charges > 0) return 'charge'
  if (!ledger.readAt) return 'never_read'
  const read = Date.parse(ledger.readAt)
  const since = Date.parse(ledger.since)
  if (Number.isNaN(read) || Number.isNaN(since)) return 'never_read'
  return read <= since ? 'before_job' : 'clear'
}

// ── A certificate job's certificate (migration 42) ─────────────────────────

const sslJobCertificateSchema = z.object({
  commonName: z.string().min(1),
  orderItemId: z.string().regex(UUID),
})

/** `admin_ssl_job_certificate`: the certificate's name and its order line, nothing more. */
export type SslJobCertificate = z.infer<typeof sslJobCertificateSchema>

/** SQL's answer, or null when there is none or it is not that shape. */
export function parseSslJobCertificate(data: unknown): SslJobCertificate | null {
  const parsed = sslJobCertificateSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

// ── Paid lines with no job ─────────────────────────────────────────────────

/** A paid order has 5 minutes to queue its jobs before a line counts as missing one. */
export const PENDING_GRACE_MS = 5 * 60_000

export type PendingLine = {
  id: string
  orderId: string
  itemType: string
  status: string
}

/**
 * The domain lines that have no job, as the sidebar's attention count counts
 * them: pending lines of a paid order, registration, renewal or transfer,
 * with no job row. Certificate lines are counted by SQL alone (their
 * certificate rows are B10's to read), so they are left out here.
 */
export function linesWithoutJob<L extends PendingLine>(
  lines: readonly L[],
  linesWithJob: ReadonlySet<string>,
): L[] {
  return lines.filter(
    (line) =>
      line.status === 'pending' &&
      ['register', 'renew', 'transfer'].includes(line.itemType) &&
      !linesWithJob.has(line.id),
  )
}
