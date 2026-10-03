import 'server-only'

import { type DetailLine, detailLines, maskEmailsIn } from '@/features/admin/lib/audit-detail'
import { type AuditParams, watDayEnd, watDayStart } from '@/features/admin/lib/audit-params'
import { pageRange } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'

/**
 * The audit log's reads (docs/ADMIN-SPEC.md §2.5, §5.2 B14), through adminDb
 * and nothing else: `admin_audit_log` is select-only for the service role,
 * and adminDb applies its `test_actor` rule — a test administrator reads test
 * administrators' rows only (D15); anyone else, every row. Read-only: the log
 * is append-only, and no admin page changes it.
 *
 * Never read: `error` (a raw database message, §2.4: never shown),
 * `admin_id` and `request_key`. `detail` and the typed reason are turned into
 * safe text here, on the server, so a hidden value never reaches the page.
 */

/** A read that failed: the page shows its error state with "Try again". */
export class AuditReadError extends Error {
  constructor(what: string, code?: string) {
    super(`audit read failed: ${what}`)
    this.name = 'AuditReadError'
    logger.warn({ what, code }, 'admin audit read failed')
  }
}

/** What the gateway recorded against an intent note (§2.5: one result per note). */
export type AuditResult = {
  id: number
  outcome: string
  errorCode: string | null
  createdAt: string
}

export type AuditEntry = {
  id: number
  createdAt: string
  adminLabel: string
  adminRole: string
  testActor: boolean
  /** The first characters of the sign-in's hashed session id: entries from one sign-in. */
  session: string | null
  action: string
  side: string | null
  targetType: string | null
  targetId: string | null
  targetTestMode: boolean | null
  /** The typed reason, any email in it masked; null once redacted. */
  reason: string | null
  redactedAt: string | null
  outcome: string
  errorCode: string | null
  detail: DetailLine[]
  /** For a gateway result: the intent note it answers. */
  parentId: number | null
  requestId: string | null
  /** For an intent note: what the gateway recorded, or null for nothing yet. */
  result: AuditResult | null
}

export type AuditPage = { rows: AuditEntry[]; total: number }

type Row = {
  id: number
  created_at: string
  admin_label: string
  admin_role: string
  test_actor: boolean
  session_hash: string | null
  action: string
  side: string | null
  target_type: string | null
  target_id: string | null
  target_test_mode: boolean | null
  reason: string | null
  redacted_at: string | null
  outcome: string
  error_code: string | null
  detail: unknown
  parent_id: number | null
  request_id: string | null
}

function toEntry(row: Row, result: AuditResult | null): AuditEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    adminLabel: row.admin_label,
    adminRole: row.admin_role,
    testActor: row.test_actor,
    session: row.session_hash ? row.session_hash.slice(0, 8) : null,
    action: row.action,
    side: row.side,
    targetType: row.target_type,
    // No wrapper names a target by an email; masked all the same (N13).
    targetId: row.target_id === null ? null : maskEmailsIn(row.target_id),
    targetTestMode: row.target_test_mode,
    reason: row.reason === null ? null : maskEmailsIn(row.reason),
    redactedAt: row.redacted_at,
    outcome: row.outcome,
    errorCode: row.error_code,
    detail: detailLines(row.detail),
    parentId: row.parent_id,
    requestId: row.request_id,
    result,
  }
}

/** The gateway's answers to these intent notes, by the note's id. */
async function resultsFor(
  admin: AdminPrincipal,
  side: AdminSide,
  intents: number[],
): Promise<Map<number, AuditResult>> {
  if (intents.length === 0) return new Map()
  const answer = await adminDb(admin, side)
    .from('admin_audit_log')
    .select('id, parent_id, outcome, error_code, created_at')
    .in('parent_id', intents)
  if (answer.error) throw new AuditReadError('gateway results', answer.error.code)
  const results = new Map<number, AuditResult>()
  for (const row of answer.data ?? []) {
    if (row.parent_id === null) continue
    results.set(row.parent_id, {
      id: row.id,
      outcome: row.outcome,
      errorCode: row.error_code,
      createdAt: row.created_at,
    })
  }
  return results
}

/**
 * One page of the log, newest first unless asked otherwise, narrowed by the
 * URL's filters; each intent note comes with the gateway's result.
 */
export async function listAuditEntries(
  admin: AdminPrincipal,
  side: AdminSide,
  params: AuditParams,
): Promise<AuditPage> {
  const { from, to } = pageRange(params.list)
  let query = adminDb(admin, side)
    .from('admin_audit_log')
    .select(
      'id, created_at, admin_label, admin_role, test_actor, session_hash, action, side, target_type, target_id, target_test_mode, reason, redacted_at, outcome, error_code, detail, parent_id, request_id',
      { count: 'exact' },
    )
  if (params.id !== null) query = query.eq('id', params.id)
  // `refund.%`: the family's actions. Actions are `prefix.verb` (a check in SQL).
  if (params.prefix) query = query.like('action', `${params.prefix}.%`)
  if (params.outcome.length > 0) query = query.in('outcome', params.outcome)
  if (params.side) query = query.eq('side', params.side)
  if (params.who) query = query.eq('test_actor', params.who === 'test')
  if (params.admin) query = query.eq('admin_label', params.admin)
  if (params.target) query = query.eq('target_id', params.target)
  if (params.list.from) query = query.gte('created_at', watDayStart(params.list.from))
  if (params.list.to) query = query.lt('created_at', watDayEnd(params.list.to))
  const ascending = params.list.dir === 'asc'
  const answer = await query
    .order('created_at', { ascending })
    .order('id', { ascending })
    .range(from, to)
  if (answer.error) throw new AuditReadError('entries', answer.error.code)
  const rows = (answer.data ?? []) as Row[]
  const results = await resultsFor(
    admin,
    side,
    rows.filter((row) => row.outcome === 'intent').map((row) => row.id),
  )
  return {
    total: answer.count ?? rows.length,
    rows: rows.map((row) => toEntry(row, results.get(row.id) ?? null)),
  }
}

/** How many entries the overview shows (§5.2 B1). */
export const LATEST_AUDIT_COUNT = 10

/**
 * The newest entries, for the overview (§5.2 B1): the same read and the
 * same safe text as the log's first page, under the same `test_actor` rule
 * — a test administrator sees test administrators' entries only.
 */
export async function latestAuditEntries(
  admin: AdminPrincipal,
  side: AdminSide,
  count: number = LATEST_AUDIT_COUNT,
): Promise<AuditEntry[]> {
  const answer = await adminDb(admin, side)
    .from('admin_audit_log')
    .select(
      'id, created_at, admin_label, admin_role, test_actor, session_hash, action, side, target_type, target_id, target_test_mode, reason, redacted_at, outcome, error_code, detail, parent_id, request_id',
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(count)
  if (answer.error) throw new AuditReadError('latest entries', answer.error.code)
  const rows = (answer.data ?? []) as Row[]
  const results = await resultsFor(
    admin,
    side,
    rows.filter((row) => row.outcome === 'intent').map((row) => row.id),
  )
  return rows.map((row) => toEntry(row, results.get(row.id) ?? null))
}
