import 'server-only'

import { z } from 'zod'
import { pageRange } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  SSL_SORT_COLUMN,
  type SslListParams,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/ssl-params'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The certificate pages' reads (docs/ADMIN-SPEC.md §5.2 B10). Certificates
 * come only through `admin_ssl_certificates_v`, which has no CSR, no contact
 * and no approver address — only `approver_masked` — and the certificate's
 * own public text. Jobs, lines, refunds and supplier calls through adminDb,
 * which applies the side; the figures through `admin_ssl_stats`. Nothing
 * here calls the supplier: a status read is a button (D22).
 */

/** A read that failed: the page shows its error state with "Try again". */
export class SslReadError extends Error {
  constructor(what: string, code?: string) {
    super(`certificate read failed: ${what}`)
    this.name = 'SslReadError'
    logger.warn({ what, code }, 'admin certificate read failed')
  }
}

type Answer = { data: unknown; error: { code?: string; message: string } | null }

/** A read's rows, or the error state: a failed read is never shown as an empty one. */
function must<R extends Answer>(what: string, answer: R): R['data'] {
  if (answer.error) throw new SslReadError(what, answer.error.code)
  return answer.data
}

/** One part of a page: its data, or that it could not be read (its own error state). */
export type Section<T> = { ok: true; data: T } | { ok: false }

async function section<T>(read: Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await read }
  } catch {
    return { ok: false }
  }
}

// ── The list ───────────────────────────────────────────────────────────────

export type CertificateRow = {
  id: string
  userId: string | null
  commonName: string
  productCode: string | null
  productName: string | null
  isWildcard: boolean
  testMode: boolean
  status: string
  supplierStatus: string | null
  unrecognisedSince: string | null
  purchasedAt: string | null
  subscriptionEndsAt: string | null
  expiresAt: string | null
  lastCheckedAt: string | null
  lastErrorCode: string | null
  reissueCount: number
  createdAt: string | null
}

export type CertificateList = { rows: CertificateRow[]; total: number }

type ListRow = {
  id: string | null
  user_id: string | null
  product_code: string | null
  product_name: string | null
  is_wildcard: boolean | null
  common_name: string | null
  test_mode: boolean | null
  status: string | null
  supplier_status: string | null
  status_unrecognised_since: string | null
  purchased_at: string | null
  subscription_ends_at: string | null
  expires_at: string | null
  last_checked_at: string | null
  last_error_code: string | null
  reissue_count: number | null
  created_at: string | null
}

function toRow(row: ListRow): CertificateRow | null {
  if (!row.id || !row.common_name) return null
  return {
    id: row.id,
    userId: row.user_id,
    commonName: row.common_name,
    productCode: row.product_code,
    productName: row.product_name,
    isWildcard: row.is_wildcard === true,
    testMode: row.test_mode === true,
    status: row.status ?? '',
    supplierStatus: row.supplier_status,
    unrecognisedSince: row.status_unrecognised_since,
    purchasedAt: row.purchased_at,
    subscriptionEndsAt: row.subscription_ends_at,
    expiresAt: row.expires_at,
    lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code,
    reissueCount: row.reissue_count ?? 0,
    createdAt: row.created_at,
  }
}

/**
 * A page of certificates on the side, filtered and sorted from the URL. A
 * search that is not a name (an email, anything else) is never sent: the
 * page says why instead, and this is not called.
 */
export async function listCertificates(
  admin: AdminPrincipal,
  side: AdminSide,
  params: SslListParams,
): Promise<CertificateList> {
  const { from, to } = pageRange(params)
  let query = adminDb(admin, side)
    .from('admin_ssl_certificates_v')
    .select(
      'id, user_id, product_code, product_name, is_wildcard, common_name, test_mode, status, supplier_status, status_unrecognised_since, purchased_at, subscription_ends_at, expires_at, last_checked_at, last_error_code, reissue_count, created_at',
      { count: 'exact' },
    )
  if (params.status.length > 0) query = query.in('status', params.status)
  if (params.unrecognised) query = query.not('status_unrecognised_since', 'is', null)
  if (params.line) query = query.eq('order_item_id', params.line)
  if (params.search.kind === 'name') query = query.in('common_name', params.search.names)
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayEnd(params.to))
  const answer = await query
    .order(SSL_SORT_COLUMN[params.sort], { ascending: params.dir === 'asc', nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, to)
  const rows = (must('certificates', answer) ?? []) as ListRow[]
  return {
    total: answer.count ?? rows.length,
    rows: rows.flatMap((row) => {
      const mapped = toRow(row)
      return mapped ? [mapped] : []
    }),
  }
}

// ── The figures ────────────────────────────────────────────────────────────

const count = z.coerce.number().int().nonnegative().catch(0)

const statsSchema = z.object({
  byStatus: z.array(z.object({ status: z.string(), count })).catch([]),
  unrecognised: count,
  jobs: z.array(z.object({ kind: z.string(), status: z.string(), count })).catch([]),
})

export type SslStats = {
  /** Certificates by our status. */
  byStatus: Record<string, number>
  total: number
  /** Certificates whose last supplier word is not one we know. */
  unrecognised: number
  /** Certificate jobs waiting for a person. */
  jobsNeedingPerson: number
  /** Certificate jobs queued or with a worker. */
  jobsOpen: number
}

/** `admin_ssl_stats`, asked of SQL as this admin (test side only for a test admin). */
export async function getSslStats(side: AdminSide): Promise<SslStats> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_ssl_stats', { p_test_mode: side === 'test' })
  if (error) throw new SslReadError('figures', error.code)
  const parsed = statsSchema.parse(data ?? {})
  const byStatus: Record<string, number> = {}
  for (const row of parsed.byStatus) byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count
  const jobs = (statuses: string[]) =>
    parsed.jobs
      .filter((job) => statuses.includes(job.status))
      .reduce((sum, job) => sum + job.count, 0)
  return {
    byStatus,
    total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
    unrecognised: parsed.unrecognised,
    jobsNeedingPerson: jobs(['needs_attention']),
    jobsOpen: jobs(['queued', 'running']),
  }
}

// ── Paid lines with no certificate ─────────────────────────────────────────

/** A paid certificate line is given its certificate in the payment's transaction; this long is grace. */
export const PAID_GRACE_MS = 5 * 60 * 1000

export type PaidLine = {
  id: string
  orderId: string
  orderNumber: string | null
  name: string
  productCode: string | null
  paidAt: string | null
}

/**
 * Paid certificate lines with no certificate — what SQL counts in
 * `pendingWithoutJob` for certificates (B4 links here for them). The newest
 * 100 paid orders still settling are read, as the queue reads them.
 */
export async function listPaidWithoutCertificate(
  admin: AdminPrincipal,
  side: AdminSide,
  now: Date,
): Promise<PaidLine[]> {
  const db = adminDb(admin, side)
  const before = new Date(now.getTime() - PAID_GRACE_MS).toISOString()
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
  if (orderIds.length === 0) return []
  const lines =
    must(
      'certificate lines',
      await db
        .from('order_items')
        .select('id, order_id, domain, ssl_product_code')
        .in('order_id', orderIds)
        .eq('item_type', 'ssl')
        .eq('status', 'pending')
        .limit(500),
    ) ?? []
  if (lines.length === 0) return []
  const certificates =
    must(
      'certificates for lines',
      await db
        .from('admin_ssl_certificates_v')
        .select('order_item_id')
        .in(
          'order_item_id',
          lines.map((line) => line.id),
        ),
    ) ?? []
  const held = new Set(
    certificates.flatMap((row) => (row.order_item_id ? [row.order_item_id] : [])),
  )
  const byOrder = new Map(orders.map((order) => [order.id, order]))
  return lines
    .filter((line) => !held.has(line.id))
    .map((line) => {
      const order = byOrder.get(line.order_id)
      return {
        id: line.id,
        orderId: line.order_id,
        orderNumber: order?.order_number ?? null,
        name: line.domain,
        productCode: line.ssl_product_code,
        paidAt: order?.paid_at ?? null,
      }
    })
}

// ── One certificate ────────────────────────────────────────────────────────

type Db = ReturnType<typeof adminDb>

export type CertificateRecord = CertificateRow & {
  orderItemId: string | null
  includedNames: number
  sanNames: string[]
  supplierCertificateId: string | null
  validationMethod: string | null
  /** The approval address, masked by SQL (`admin_mask_email`) — never the address. */
  approverMasked: string | null
  webServer: string | null
  configuredAt: string | null
  issuedAt: string | null
  /** The certificate and its chain: public, so kept and shown (FR-SSL-7). */
  certificatePem: string | null
  caBundlePem: string | null
  nextCheckAt: string | null
  updatedAt: string | null
}

export type CertificateLine = {
  id: string
  orderId: string
  orderNumber: string | null
  name: string
  priceKobo: number
  renewalKobo: number
  status: string
  failureCode: string | null
}

export type CertificateJob = {
  id: string
  kind: string
  status: string
  attempts: number
  lastErrorCode: string | null
  sentAt: string | null
  runAfter: string
  createdAt: string
  finishedAt: string | null
}

export type CertificateRefund = {
  id: string
  status: string
  amountKobo: number
  reason: string
  createdAt: string
}

export type CertificateCall = {
  id: number
  createdAt: string
  operation: string
  outcome: string
  errorCode: string | null
  httpStatus: number | null
  durationMs: number
  sslJobId: string | null
}

export type CertificateDetail = {
  certificate: CertificateRecord
  line: Section<CertificateLine | null>
  jobs: Section<CertificateJob[]>
  refunds: Section<CertificateRefund[]>
  calls: Section<CertificateCall[]>
}

/** How many supplier calls the page lists, newest first. */
export const CALLS_SHOWN = 50

async function readCertificate(db: Db, id: string): Promise<CertificateRecord | null> {
  const row = must(
    'certificate',
    await db
      .from('admin_ssl_certificates_v')
      .select(
        'id, user_id, order_item_id, product_code, product_name, is_wildcard, included_names, common_name, test_mode, status, supplier_status, status_unrecognised_since, supplier_certificate_id, purchased_at, subscription_ends_at, validation_method, san_names, web_server, configured_at, last_error_code, issued_at, expires_at, certificate_pem, ca_bundle_pem, reissue_count, last_checked_at, next_check_at, created_at, updated_at, approver_masked',
      )
      .eq('id', id)
      .maybeSingle(),
  )
  if (!row) return null
  const base = toRow(row)
  if (!base) return null
  return {
    ...base,
    orderItemId: row.order_item_id,
    includedNames: row.included_names ?? 1,
    sanNames: row.san_names ?? [],
    supplierCertificateId: row.supplier_certificate_id,
    validationMethod: row.validation_method,
    approverMasked: row.approver_masked,
    webServer: row.web_server,
    configuredAt: row.configured_at,
    issuedAt: row.issued_at,
    certificatePem: row.certificate_pem,
    caBundlePem: row.ca_bundle_pem,
    nextCheckAt: row.next_check_at,
    updatedAt: row.updated_at,
  }
}

async function readLine(db: Db, id: string): Promise<CertificateLine | null> {
  const line = must(
    'certificate line',
    await db
      .from('order_items')
      .select('id, order_id, domain, price_kobo, renewal_kobo, status, failure_code')
      .eq('id', id)
      .maybeSingle(),
  )
  if (!line) return null
  const order = must(
    'certificate order',
    await db
      .from('admin_orders_v')
      .select('id, order_number')
      .eq('id', line.order_id)
      .maybeSingle(),
  )
  return {
    id: line.id,
    orderId: line.order_id,
    orderNumber: order?.order_number ?? null,
    name: line.domain,
    priceKobo: Number(line.price_kobo),
    renewalKobo: Number(line.renewal_kobo),
    status: line.status,
    failureCode: line.failure_code,
  }
}

async function readJobs(db: Db, certificateId: string): Promise<CertificateJob[]> {
  const rows = must(
    'certificate jobs',
    await db
      .from('ssl_jobs')
      .select(
        'id, kind, status, attempts, last_error_code, sent_at, run_after, created_at, finished_at',
      )
      .eq('certificate_id', certificateId)
      .order('created_at', { ascending: false })
      .limit(50),
  )
  return (rows ?? []).map((job) => ({
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    lastErrorCode: job.last_error_code,
    sentAt: job.sent_at,
    runAfter: job.run_after,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
  }))
}

async function readRefunds(db: Db, lineId: string): Promise<CertificateRefund[]> {
  const rows = must(
    'certificate refunds',
    await db
      .from('refunds')
      .select('id, status, amount_kobo, reason, created_at')
      .eq('order_item_id', lineId)
      .order('created_at', { ascending: false }),
  )
  return (rows ?? []).map((refund) => ({
    id: refund.id,
    status: refund.status,
    amountKobo: Number(refund.amount_kobo),
    reason: refund.reason,
    createdAt: refund.created_at,
  }))
}

/**
 * The supplier calls about this certificate: every SSL call is recorded under
 * the name the supplier knows it by, from the day it was ordered. Never the
 * call's message — the supplier's own words (N10).
 */
async function readCalls(db: Db, name: string, since: string | null): Promise<CertificateCall[]> {
  let query = db
    .from('supplier_calls')
    .select('id, created_at, operation, outcome, error_code, http_status, duration_ms, ssl_job_id')
    .eq('domain_name', name)
  if (since) query = query.gte('created_at', since)
  const rows = must(
    'certificate supplier calls',
    await query.order('created_at', { ascending: false }).limit(CALLS_SHOWN),
  )
  return (rows ?? []).map((call) => ({
    id: call.id,
    createdAt: call.created_at,
    operation: call.operation,
    outcome: call.outcome,
    errorCode: call.error_code,
    httpStatus: call.http_status,
    durationMs: call.duration_ms,
    sslJobId: call.ssl_job_id,
  }))
}

/**
 * One certificate with what its page shows, or null when this side has no
 * such certificate. The certificate itself must read; each other part has
 * its own error state.
 */
export async function getCertificate(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<CertificateDetail | null> {
  const db = adminDb(admin, side)
  const certificate = await readCertificate(db, id)
  if (!certificate) return null
  const lineId = certificate.orderItemId
  const [line, jobs, refunds, calls] = await Promise.all([
    section(lineId ? readLine(db, lineId) : Promise.resolve(null)),
    section(readJobs(db, certificate.id)),
    section(lineId ? readRefunds(db, lineId) : Promise.resolve([])),
    section(readCalls(db, certificate.commonName, certificate.createdAt)),
  ])
  return { certificate, line, jobs, refunds, calls }
}
