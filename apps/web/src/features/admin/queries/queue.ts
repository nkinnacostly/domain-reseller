import 'server-only'

import { z } from 'zod'
import type { ListParams } from '@/features/admin/lib/list-params'
import { pageRange } from '@/features/admin/lib/list-params'
import {
  addDays,
  type DomainJobKind,
  JOB_SORT_COLUMN,
  type JobFilters,
  type JobLedger,
  type JobSort,
  type JobStatus,
  type LineRefund,
  linesWithoutJob,
  PENDING_GRACE_MS,
  parseJobLedger,
  parseSslJobCertificate,
  type ReadCall,
  type RefundLine,
  type SslJobCertificate,
  watDate,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/queue-facts'
import type { AdminSide } from '@/features/admin/lib/side'
import { getAttentionCounts } from '@/features/admin/queries/attention'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The queue's reads (docs/ADMIN-SPEC.md §5.2 B4): registration, renewal,
 * transfer and settings jobs, certificate jobs, and paid lines with no job.
 * Row lists come through adminDb, which applies the side; the provisioning
 * aggregate through `admin_provisioning`. A job's domain name comes from
 * `admin_domains_v` — never from `domains`, and never a registrant (§9).
 * Two narrow SQL reads (migration 42) give what the queue may not read
 * itself: a registration's ledger check as a count (`admin_job_ledger`), and
 * a certificate job's name and line (`admin_ssl_job_certificate`).
 */

/** A read that failed: the page shows its error state with "Try again". */
export class QueueReadError extends Error {
  constructor(what: string, code?: string) {
    super(`queue read failed: ${what}`)
    this.name = 'QueueReadError'
    logger.warn({ what, code }, 'admin queue read failed')
  }
}

type Answer = { data: unknown; error: { code?: string; message: string } | null }

/** A read's rows, or the error state: a failed read is never shown as an empty one. */
function must<R extends Answer>(what: string, answer: R): R['data'] {
  if (answer.error) throw new QueueReadError(what, answer.error.code)
  return answer.data
}

// ── Lists ──────────────────────────────────────────────────────────────────

export type JobRow = {
  id: string
  kind: string
  status: string
  attempts: number
  lastErrorCode: string | null
  runAfter: string
  createdAt: string
  updatedAt: string
  testMode: boolean
  domainId: string
  domainName: string | null
}

export type JobPage = { rows: JobRow[]; total: number }

/** Domain names by id, through the masked view (`admin_domains_v`). */
async function domainNames(
  admin: AdminPrincipal,
  side: AdminSide,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = must(
    'domain names',
    await adminDb(admin, side).from('admin_domains_v').select('id, domain_name').in('id', unique),
  )
  return new Map(
    (rows ?? []).flatMap((row) => (row.id && row.domain_name ? [[row.id, row.domain_name]] : [])),
  )
}

export async function listJobs(
  admin: AdminPrincipal,
  side: AdminSide,
  params: ListParams<JobSort, JobStatus>,
  filters: JobFilters,
): Promise<JobPage> {
  const { from, to } = pageRange(params)
  let query = adminDb(admin, side)
    .from('jobs')
    .select(
      'id, kind, status, attempts, last_error_code, run_after, created_at, updated_at, test_mode, domain_id',
      { count: 'exact' },
    )
  if (params.status.length > 0) query = query.in('status', params.status)
  if (filters.kind) query = query.eq('kind', filters.kind as DomainJobKind)
  if (filters.domainId) query = query.eq('domain_id', filters.domainId)
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayEnd(params.to))
  const answer = await query
    .order(JOB_SORT_COLUMN[params.sort], { ascending: params.dir === 'asc' })
    .order('id', { ascending: true })
    .range(from, to)
  const rows = must('jobs', answer) ?? []
  const names = await domainNames(
    admin,
    side,
    rows.map((row) => row.domain_id),
  )
  return {
    total: answer.count ?? rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      lastErrorCode: row.last_error_code,
      runAfter: row.run_after,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      testMode: row.test_mode,
      domainId: row.domain_id,
      domainName: names.get(row.domain_id) ?? null,
    })),
  }
}

export type SslJobRow = {
  id: string
  kind: string
  status: string
  attempts: number
  lastErrorCode: string | null
  runAfter: string
  sentAt: string | null
  createdAt: string
  updatedAt: string
  testMode: boolean
  certificateId: string
}

export async function listSslJobs(
  admin: AdminPrincipal,
  side: AdminSide,
  params: ListParams<JobSort, JobStatus>,
  filters: JobFilters,
): Promise<{ rows: SslJobRow[]; total: number }> {
  const { from, to } = pageRange(params)
  let query = adminDb(admin, side)
    .from('ssl_jobs')
    .select(
      'id, kind, status, attempts, last_error_code, run_after, sent_at, created_at, updated_at, test_mode, certificate_id',
      { count: 'exact' },
    )
  if (params.status.length > 0) query = query.in('status', params.status)
  if (filters.kind) query = query.eq('kind', filters.kind)
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayEnd(params.to))
  const answer = await query
    .order(JOB_SORT_COLUMN[params.sort], { ascending: params.dir === 'asc' })
    .order('id', { ascending: true })
    .range(from, to)
  const rows = must('certificate jobs', answer) ?? []
  return {
    total: answer.count ?? rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      lastErrorCode: row.last_error_code,
      runAfter: row.run_after,
      sentAt: row.sent_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      testMode: row.test_mode,
      certificateId: row.certificate_id,
    })),
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────

const count = z.coerce.number().int().nonnegative().catch(0)

const provisioningSchema = z.object({
  jobs: z.array(z.object({ kind: z.string(), status: z.string(), count })).catch([]),
  ssl: z.array(z.object({ kind: z.string(), status: z.string(), count })).catch([]),
})

export type KindStatusCount = { kind: string; status: string; count: number }

export type QueueStats = {
  needsAttention: { jobs: number; ssl: number }
  open: { jobs: number; ssl: number }
  /** The last 30 days, by WAT day of creation. */
  last30: { from: string; to: string; jobs: KindStatusCount[]; ssl: KindStatusCount[] }
}

async function countWhere(
  admin: AdminPrincipal,
  side: AdminSide,
  table: 'jobs' | 'ssl_jobs',
  statuses: JobStatus[],
): Promise<number> {
  const answer = await adminDb(admin, side)
    .from(table)
    .select('id', { count: 'exact', head: true })
    .in('status', statuses)
  if (answer.error) throw new QueueReadError(`${table} count`, answer.error.code)
  return answer.count ?? 0
}

export async function getQueueStats(
  admin: AdminPrincipal,
  side: AdminSide,
  now: Date,
): Promise<QueueStats> {
  const to = watDate(now)
  const from = addDays(to, -29)
  const supabase = await createClient()
  const [jobsAttention, sslAttention, jobsOpen, sslOpen, provisioning] = await Promise.all([
    countWhere(admin, side, 'jobs', ['needs_attention']),
    countWhere(admin, side, 'ssl_jobs', ['needs_attention']),
    countWhere(admin, side, 'jobs', ['queued', 'running']),
    countWhere(admin, side, 'ssl_jobs', ['queued', 'running']),
    supabase.rpc('admin_provisioning', { p_test_mode: side === 'test', p_from: from, p_to: to }),
  ])
  if (provisioning.error) throw new QueueReadError('provisioning', provisioning.error.code)
  const parsed = provisioningSchema.parse(provisioning.data ?? {})
  return {
    needsAttention: { jobs: jobsAttention, ssl: sslAttention },
    open: { jobs: jobsOpen, ssl: sslOpen },
    last30: { from, to, jobs: parsed.jobs, ssl: parsed.ssl },
  }
}

// ── Paid lines with no job ─────────────────────────────────────────────────

export type PendingRow = {
  id: string
  orderId: string
  orderNumber: string | null
  domain: string
  itemType: string
  status: string
  paidAt: string | null
}

export type PendingReport = {
  rows: PendingRow[]
  /** Certificate lines SQL counts as missing their certificate (B10 reads those). */
  certificateLines: number | null
}

export async function listPendingWithoutJob(
  admin: AdminPrincipal,
  side: AdminSide,
  now: Date,
): Promise<PendingReport> {
  const db = adminDb(admin, side)
  const before = new Date(now.getTime() - PENDING_GRACE_MS).toISOString()
  const orders =
    must(
      'paid orders',
      await db
        .from('admin_orders_v')
        .select('id, order_number, paid_at')
        .not('payment_id', 'is', null)
        .in('status', ['paid', 'provisioning'])
        .lt('paid_at', before)
        .order('paid_at', { ascending: true })
        .limit(100),
    ) ?? []
  const orderIds = orders.flatMap((order) => (order.id ? [order.id] : []))
  const counted = await getAttentionCounts(side)
  if (orderIds.length === 0) {
    return { rows: [], certificateLines: counted ? counted.pendingWithoutJob : null }
  }
  const lines =
    must(
      'pending lines',
      await db
        .from('order_items')
        .select('id, order_id, domain, item_type, status')
        .in('order_id', orderIds)
        .eq('status', 'pending')
        .limit(500),
    ) ?? []
  const lineIds = lines.map((line) => line.id)
  const jobs =
    lineIds.length === 0
      ? []
      : (must(
          'jobs for pending lines',
          await db.from('jobs').select('order_item_id').in('order_item_id', lineIds),
        ) ?? [])
  const withJob = new Set(jobs.flatMap((job) => (job.order_item_id ? [job.order_item_id] : [])))
  const missing = linesWithoutJob(
    lines.map((line) => ({
      id: line.id,
      orderId: line.order_id,
      domain: line.domain,
      itemType: line.item_type,
      status: line.status,
    })),
    withJob,
  )
  const byOrder = new Map(orders.map((order) => [order.id, order]))
  return {
    rows: missing.map((line) => {
      const order = byOrder.get(line.orderId)
      return { ...line, orderNumber: order?.order_number ?? null, paidAt: order?.paid_at ?? null }
    }),
    certificateLines: counted ? Math.max(0, counted.pendingWithoutJob - missing.length) : null,
  }
}

// ── One job ────────────────────────────────────────────────────────────────

type Db = ReturnType<typeof adminDb>

export type SupplierCallRow = {
  id: number
  createdAt: string
  operation: string
  outcome: string
  errorCode: string | null
  httpStatus: number | null
  durationMs: number
}

export type JobLine = {
  id: string
  orderId: string
  orderNumber: string | null
  itemType: string
  domain: string
  periodYears: number
  renewalYears: number
  priceKobo: number
  renewalKobo: number
  status: string
  failureCode: string | null
}

export type JobDomain = {
  id: string
  name: string
  localStatus: string | null
  expiresAt: string | null
  transferLock: boolean | null
  privacyEnabled: boolean | null
  pendingTransferLock: boolean | null
  pendingPrivacy: boolean | null
  source: string | null
}

export type JobRefund = LineRefund & {
  reason: string
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
}

export type JobEvent = { id: number; eventType: string; actorType: string; createdAt: string }

export type JobRecord = {
  id: string
  kind: string
  status: string
  attempts: number
  lastErrorCode: string | null
  runAfter: string
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  submittedAt: string | null
  baselineExpiry: string | null
  lockedAt: string | null
  lockedBy: string | null
  testMode: boolean
  domainId: string
  orderItemId: string | null
}

/** A job's order line, with what its refund depends on. */
export type LineContext = {
  line: JobLine | null
  /** Every line of the line's order, for its share of the VAT. */
  orderLines: RefundLine[]
  order: { subtotalKobo: number; vatKobo: number } | null
  refunds: JobRefund[]
}

export type JobDetail = LineContext & {
  job: JobRecord
  domain: JobDomain | null
  calls: SupplierCallRow[]
  /** The newest registry read of this domain, by the worker or an admin. */
  registryRead: ReadCall | null
  /** The newest transfer state read of this domain (admins only read it). */
  transferRead: ReadCall | null
  /** When the worker last sent the write this job exists for. */
  lastAttemptAt: string | null
  /**
   * A registration's ledger check, as admin_fail_job makes it (migration 42);
   * 'unreadable' when SQL could not answer, null for other kinds.
   */
  ledger: JobLedger | 'unreadable' | null
  events: JobEvent[]
}

function toCall(row: {
  id: number
  created_at: string
  operation: string
  outcome: string
  error_code: string | null
  http_status: number | null
  duration_ms: number
}): SupplierCallRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    operation: row.operation,
    outcome: row.outcome,
    errorCode: row.error_code,
    httpStatus: row.http_status,
    durationMs: row.duration_ms,
  }
}

async function readJob(db: Db, id: string): Promise<JobRecord | null> {
  const row = must(
    'job',
    await db
      .from('jobs')
      .select(
        'id, kind, status, attempts, last_error_code, run_after, created_at, updated_at, finished_at, submitted_at, baseline_expiry, locked_at, locked_by, test_mode, domain_id, order_item_id',
      )
      .eq('id', id)
      .maybeSingle(),
  )
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    runAfter: row.run_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    submittedAt: row.submitted_at,
    baselineExpiry: row.baseline_expiry,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    testMode: row.test_mode,
    domainId: row.domain_id,
    orderItemId: row.order_item_id,
  }
}

async function readDomain(db: Db, id: string): Promise<JobDomain | null> {
  const row = must(
    'job domain',
    await db
      .from('admin_domains_v')
      .select(
        'id, domain_name, local_status, expires_at, transfer_lock, privacy_enabled, pending_transfer_lock, pending_privacy, source',
      )
      .eq('id', id)
      .maybeSingle(),
  )
  if (!row?.id || !row.domain_name) return null
  return {
    id: row.id,
    name: row.domain_name,
    localStatus: row.local_status,
    expiresAt: row.expires_at,
    transferLock: row.transfer_lock,
    privacyEnabled: row.privacy_enabled,
    pendingTransferLock: row.pending_transfer_lock,
    pendingPrivacy: row.pending_privacy,
    source: row.source,
  }
}

async function readLine(db: Db, id: string): Promise<Omit<JobLine, 'orderNumber'> | null> {
  const row = must(
    'job line',
    await db
      .from('order_items')
      .select(
        'id, order_id, item_type, domain, period_years, renewal_years, price_kobo, renewal_kobo, status, failure_code',
      )
      .eq('id', id)
      .maybeSingle(),
  )
  if (!row) return null
  return {
    id: row.id,
    orderId: row.order_id,
    itemType: row.item_type,
    domain: row.domain,
    periodYears: row.period_years,
    renewalYears: row.renewal_years,
    priceKobo: row.price_kobo,
    renewalKobo: row.renewal_kobo,
    status: row.status,
    failureCode: row.failure_code,
  }
}

async function readRefunds(db: Db, lineId: string): Promise<JobRefund[]> {
  const rows = must(
    'line refunds',
    await db
      .from('refunds')
      .select(
        'id, status, amount_kobo, reason, provider_refund_id, last_error_code, created_at, updated_at',
      )
      .eq('order_item_id', lineId)
      .order('created_at', { ascending: false }),
  )
  return (rows ?? []).map((refund) => ({
    id: refund.id,
    status: refund.status,
    amountKobo: refund.amount_kobo,
    providerRefundId: refund.provider_refund_id,
    reason: refund.reason,
    lastErrorCode: refund.last_error_code,
    createdAt: refund.created_at,
    updatedAt: refund.updated_at,
  }))
}

async function readJobCalls(db: Db, jobId: string): Promise<SupplierCallRow[]> {
  const rows = must(
    'supplier calls',
    await db
      .from('supplier_calls')
      .select('id, created_at, operation, outcome, error_code, http_status, duration_ms')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(50),
  )
  return (rows ?? []).map(toCall)
}

async function readEvents(db: Db, domainId: string, since: string): Promise<JobEvent[]> {
  const rows = must(
    'domain events',
    await db
      .from('domain_events')
      .select('id, event_type, actor_type, created_at')
      .eq('domain_id', domainId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(30),
  )
  return (rows ?? []).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    actorType: event.actor_type,
    createdAt: event.created_at,
  }))
}

async function readOrder(
  db: Db,
  orderId: string,
): Promise<{ orderNumber: string | null; subtotalKobo: number | null; vatKobo: number | null }> {
  const row = must(
    'job order',
    await db
      .from('admin_orders_v')
      .select('order_number, subtotal_kobo, vat_kobo')
      .eq('id', orderId)
      .maybeSingle(),
  )
  return {
    orderNumber: row?.order_number ?? null,
    subtotalKobo: row?.subtotal_kobo ?? null,
    vatKobo: row?.vat_kobo ?? null,
  }
}

async function readOrderLines(db: Db, orderId: string): Promise<RefundLine[]> {
  const rows = must(
    'order lines',
    await db.from('order_items').select('id, price_kobo, created_at').eq('order_id', orderId),
  )
  return (rows ?? []).map((line) => ({
    id: line.id,
    priceKobo: line.price_kobo,
    createdAt: line.created_at,
  }))
}

async function readRegistryRead(db: Db, name: string): Promise<ReadCall | null> {
  const row = must(
    'registry read',
    await db
      .from('supplier_calls')
      .select('created_at, outcome')
      .eq('domain_name', name)
      .in('operation', ['GetDetails', 'AdminGetDetails'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  )
  return row ? { createdAt: row.created_at, outcome: row.outcome } : null
}

const TRANSFER_STATES: ReadonlySet<string> = new Set([
  'pending',
  'completed',
  'rejected',
  'cancelled',
  'unknown',
])

async function readTransferRead(db: Db, name: string): Promise<ReadCall | null> {
  const row = must(
    'transfer read',
    await db
      .from('supplier_calls')
      .select('created_at, outcome, message')
      .eq('domain_name', name)
      .eq('operation', 'AdminTransferQuery')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  )
  if (!row) return null
  return {
    createdAt: row.created_at,
    outcome: row.outcome,
    // The gateway records its own state word here (§4.3), never the supplier's text.
    state: row.message && TRANSFER_STATES.has(row.message) ? row.message : null,
  }
}

/** The write each kind sends: Fail needs a read after the last one. */
const ATTEMPT_OPERATION: Readonly<Record<string, string>> = {
  register_domain: 'RegisterWithContactInfo',
  transfer_domain: 'Transfer',
}

/** A job's order line, its order's lines and totals, and its refunds; empty without a line. */
async function readLineContext(db: Db, lineId: string | null): Promise<LineContext> {
  if (!lineId) return { line: null, orderLines: [], order: null, refunds: [] }
  const [line, refunds] = await Promise.all([readLine(db, lineId), readRefunds(db, lineId)])
  const [order, orderLines] = await Promise.all([
    line ? readOrder(db, line.orderId) : Promise.resolve(null),
    line ? readOrderLines(db, line.orderId) : Promise.resolve([]),
  ])
  return {
    line: line ? { ...line, orderNumber: order?.orderNumber ?? null } : null,
    orderLines,
    order:
      order && order.subtotalKobo !== null && order.vatKobo !== null
        ? { subtotalKobo: order.subtotalKobo, vatKobo: order.vatKobo }
        : null,
    refunds,
  }
}

/**
 * When the supplier ledger was last read, and how many charges name the
 * job's domain since it started — `admin_job_ledger`, admin_fail_job's own
 * LEDGER_SHOWS_CHARGE test as a count (migration 42). No ledger row reaches
 * the queue (§9). 'unreadable' when SQL could not answer.
 */
async function readJobLedger(job: JobRecord): Promise<JobLedger | 'unreadable'> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_job_ledger', {
    p_test_mode: job.testMode,
    p_job_id: job.id,
  })
  if (error) {
    logger.warn({ code: error.code }, 'admin queue: job ledger check unavailable')
    return 'unreadable'
  }
  return parseJobLedger(data) ?? 'unreadable'
}

/** One job with what its page shows, or null when this side has no such job. */
export async function getJob(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<JobDetail | null> {
  const db = adminDb(admin, side)
  const job = await readJob(db, id)
  if (!job) return null

  const [domain, context, calls, events, ledger] = await Promise.all([
    readDomain(db, job.domainId),
    readLineContext(db, job.orderItemId),
    readJobCalls(db, job.id),
    readEvents(db, job.domainId, job.createdAt),
    // Only a registration's Fail is refused for a charge (admin_fail_job).
    job.kind === 'register_domain' ? readJobLedger(job) : Promise.resolve(null),
  ])
  const [registryRead, transferRead] = await Promise.all([
    domain ? readRegistryRead(db, domain.name) : Promise.resolve(null),
    domain && job.kind === 'transfer_domain'
      ? readTransferRead(db, domain.name)
      : Promise.resolve(null),
  ])

  const attempt = ATTEMPT_OPERATION[job.kind]
  return {
    job,
    domain,
    ...context,
    calls,
    registryRead,
    transferRead,
    lastAttemptAt: attempt
      ? (calls.find((call) => call.operation === attempt)?.createdAt ?? null)
      : null,
    ledger,
    events,
  }
}

// ── One certificate job ────────────────────────────────────────────────────

export type SslJobDetail = LineContext & {
  job: SslJobRow & {
    finishedAt: string | null
    lockedAt: string | null
    lockedBy: string | null
  }
  /** The certificate's common name; from its supplier calls when SQL could not say. */
  name: string | null
  calls: SupplierCallRow[]
  /** The certificate's other jobs, newest first. */
  siblings: { id: string; kind: string; status: string; createdAt: string }[]
}

/**
 * The certificate's name and order line, and nothing else of it —
 * `admin_ssl_job_certificate` (migration 42); the certificate view is B10's.
 * Null when SQL could not answer: the page then names it from its calls.
 */
async function readSslJobCertificate(
  testMode: boolean,
  jobId: string,
): Promise<SslJobCertificate | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_ssl_job_certificate', {
    p_test_mode: testMode,
    p_job_id: jobId,
  })
  if (error) {
    logger.warn({ code: error.code }, 'admin queue: certificate of a job unavailable')
    return null
  }
  return parseSslJobCertificate(data)
}

export async function getSslJob(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<SslJobDetail | null> {
  const db = adminDb(admin, side)
  const row = must(
    'certificate job',
    await db
      .from('ssl_jobs')
      .select(
        'id, kind, status, attempts, last_error_code, run_after, sent_at, created_at, updated_at, finished_at, locked_at, locked_by, test_mode, certificate_id',
      )
      .eq('id', id)
      .maybeSingle(),
  )
  if (!row) return null
  const certificate = await readSslJobCertificate(row.test_mode, row.id)
  const [calls, siblings, context] = await Promise.all([
    db
      .from('supplier_calls')
      .select(
        'id, created_at, operation, outcome, error_code, http_status, duration_ms, domain_name',
      )
      .eq('ssl_job_id', row.id)
      .order('created_at', { ascending: false })
      .limit(50)
      .then((answer) => must('certificate supplier calls', answer) ?? []),
    db
      .from('ssl_jobs')
      .select('id, kind, status, created_at')
      .eq('certificate_id', row.certificate_id)
      .neq('id', row.id)
      .order('created_at', { ascending: false })
      .limit(20)
      .then((answer) => must('certificate jobs', answer) ?? []),
    readLineContext(db, certificate?.orderItemId ?? null),
  ])
  return {
    ...context,
    job: {
      id: row.id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      lastErrorCode: row.last_error_code,
      runAfter: row.run_after,
      sentAt: row.sent_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      testMode: row.test_mode,
      certificateId: row.certificate_id,
      finishedAt: row.finished_at,
      lockedAt: row.locked_at,
      lockedBy: row.locked_by,
    },
    name: certificate?.commonName ?? calls.find((call) => call.domain_name)?.domain_name ?? null,
    calls: calls.map(toCall),
    siblings: siblings.map((sibling) => ({
      id: sibling.id,
      kind: sibling.kind,
      status: sibling.status,
      createdAt: sibling.created_at,
    })),
  }
}
