import 'server-only'

import { z } from 'zod'
import { driftComparison, runOutcome } from '@/features/admin/lib/alerts-copy'
import {
  type AlertSeverity,
  type DriftSort,
  type HistorySort,
  type HistoryState,
  historyWindow,
  type OpenSort,
} from '@/features/admin/lib/alerts-params'
import { adminHref } from '@/features/admin/lib/href'
import { type ListParams, pageRange } from '@/features/admin/lib/list-params'
import type { Tone } from '@/features/admin/lib/tone'
import { type AdminPrincipal, type AdminSide, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The alerts page's reads (docs/ADMIN-SPEC.md §5.2, B5). Rows come through
 * adminDb, which applies the side; aggregates through `admin_alert_stats`;
 * the scheduled jobs through `admin_overview.health.cron`, which SQL leaves
 * out for a test administrator. An alert's `key` is read here and nowhere
 * else (§8.1), and only to build its link: it never leaves this file.
 */

export type Read<T> = { ok: true; data: T } | { ok: false }
export type Page<T> = { rows: T[]; total: number }

export type AlertRow = {
  id: number
  severity: string
  kind: string
  summary: string
  firstSeenAt: string
  lastSeenAt: string
  notifyCount: number
  resolvedAt: string | null
  /** Where the alert is worked: `adminHrefForAlertKey(key)`. */
  href: string
}

type AlertRecord = {
  id: number
  key: string
  severity: string
  kind: string
  summary: string
  first_seen_at: string
  last_seen_at: string
  notify_count: number
  resolved_at: string | null
}

const toAlert = (row: AlertRecord): AlertRow => ({
  id: row.id,
  severity: row.severity,
  kind: row.kind,
  summary: row.summary,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  notifyCount: row.notify_count,
  resolvedAt: row.resolved_at,
  href: adminHref.alert(row.key),
})

/** A read that failed: logged by what it was and its code only (N13), shown as an error state. */
function failed(what: string, error: unknown): { ok: false } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : error instanceof Error
        ? error.name
        : 'unknown'
  logger.warn({ code, what }, 'admin alerts read failed')
  return { ok: false }
}

const OPEN_ORDER: Record<OpenSort, string> = {
  severity: 'severity',
  first_seen: 'first_seen_at',
  last_seen: 'last_seen_at',
}

/**
 * Open alerts on the side: critical first, then the most recently seen —
 * one severity only when asked (`?severity=critical`, the overview's tile).
 */
export async function listOpenAlerts(
  admin: AdminPrincipal,
  side: AdminSide,
  list: ListParams<OpenSort>,
  severity: AlertSeverity | null = null,
): Promise<Read<Page<AlertRow>>> {
  const { from, to } = pageRange(list)
  try {
    let query = adminDb(admin, side)
      .from('ops_alerts')
      .select(
        'id, key, severity, kind, summary, first_seen_at, last_seen_at, notify_count, resolved_at',
        { count: 'exact' },
      )
      .is('resolved_at', null)
    if (severity) query = query.eq('severity', severity)
    const { data, error, count } = await query
      .order(OPEN_ORDER[list.sort], { ascending: list.dir === 'asc' })
      .order('last_seen_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (error) return failed('open alerts', error)
    return { ok: true, data: { rows: (data ?? []).map(toAlert), total: count ?? 0 } }
  } catch (error) {
    return failed('open alerts', error)
  }
}

const HISTORY_ORDER: Record<HistorySort, string> = {
  last_seen: 'last_seen_at',
  first_seen: 'first_seen_at',
  notified: 'notify_count',
}

/**
 * Every alert on the side, open or closed (closed ones are kept 90 days),
 * filtered by state, kind and the days it was seen in.
 */
export async function listAlertHistory(
  admin: AdminPrincipal,
  side: AdminSide,
  list: ListParams<HistorySort, HistoryState>,
  kind: string | null,
): Promise<Read<Page<AlertRow>>> {
  const { from, to } = pageRange(list)
  const { seenSince, seenBefore } = historyWindow(list)
  try {
    let query = adminDb(admin, side)
      .from('ops_alerts')
      .select(
        'id, key, severity, kind, summary, first_seen_at, last_seen_at, notify_count, resolved_at',
        { count: 'exact' },
      )
    if (list.status.length === 1) {
      query =
        list.status[0] === 'open'
          ? query.is('resolved_at', null)
          : query.not('resolved_at', 'is', null)
    }
    if (kind) query = query.eq('kind', kind)
    if (seenSince) query = query.gte('last_seen_at', seenSince)
    if (seenBefore) query = query.lt('first_seen_at', seenBefore)
    const { data, error, count } = await query
      .order(HISTORY_ORDER[list.sort], { ascending: list.dir === 'asc' })
      .order('id', { ascending: false })
      .range(from, to)
    if (error) return failed('alert history', error)
    return { ok: true, data: { rows: (data ?? []).map(toAlert), total: count ?? 0 } }
  } catch (error) {
    return failed('alert history', error)
  }
}

const whole = z.coerce.number().int().nonnegative().catch(0)
const when = z.string().min(1).nullable().catch(null)

const statsSchema = z.object({
  byKind: z
    .array(z.object({ kind: z.string(), severity: z.string(), open: whole, resolved: whole }))
    .catch([]),
  reconcile: z
    .object({ runs: whole, failed: whole, lastFinishedAt: when.optional() })
    .nullable()
    .catch(null),
  drift: z.array(z.object({ kind: z.string(), open: whole })).catch([]),
  presets: z
    .object({ hidden: whole, failing: whole, stale: whole, drafts: whole })
    .nullable()
    .catch(null),
})

export type AlertStats = z.infer<typeof statsSchema>

/**
 * `admin_alert_stats`: open and closed alerts by kind over the last `days`,
 * open drift by kind, and the host presets' health (which has no side).
 */
export async function getAlertStats(side: AdminSide, days = 30): Promise<Read<AlertStats>> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('admin_alert_stats', {
      p_test_mode: side === 'test',
      p_days: days,
    })
    if (error) return failed('alert stats', error)
    const parsed = statsSchema.safeParse(data)
    if (!parsed.success) return failed('alert stats', { code: 'shape' })
    return { ok: true, data: parsed.data }
  } catch (error) {
    return failed('alert stats', error)
  }
}

export type DriftRow = {
  id: number
  domainName: string
  /** The domain's admin page, when we hold a record of it. */
  domainHref: string | null
  kind: string
  ours: string
  registry: string
  firstSeenAt: string
  lastSeenAt: string
  lastRun: { at: string | null; failed: boolean } | null
}

const DRIFT_ORDER: Record<DriftSort, string> = {
  last_seen: 'last_seen_at',
  first_seen: 'first_seen_at',
}

/** Open drift on the side, with the reconcile run that last saw each. Read-only (D14). */
export async function listOpenDrift(
  admin: AdminPrincipal,
  side: AdminSide,
  list: ListParams<DriftSort>,
): Promise<Read<Page<DriftRow>>> {
  const { from, to } = pageRange(list)
  try {
    const db = adminDb(admin, side)
    const { data, error, count } = await db
      .from('registry_drift')
      .select(
        'id, domain_id, domain_name, kind, detail, first_seen_at, last_seen_at, last_run_id',
        { count: 'exact' },
      )
      .is('resolved_at', null)
      .order(DRIFT_ORDER[list.sort], { ascending: list.dir === 'asc' })
      .order('id', { ascending: false })
      .range(from, to)
    if (error) return failed('drift', error)
    const rows = data ?? []
    const runIds = [
      ...new Set(rows.map((row) => row.last_run_id).filter((id): id is string => id !== null)),
    ]
    const runs = new Map<string, { at: string | null; failed: boolean }>()
    if (runIds.length > 0) {
      const answer = await db
        .from('reconcile_runs')
        .select('id, started_at, finished_at, error')
        .in('id', runIds)
      if (answer.error) return failed('drift runs', answer.error)
      for (const run of answer.data ?? []) {
        runs.set(run.id, { at: run.finished_at ?? run.started_at, failed: run.error !== null })
      }
    }
    return {
      ok: true,
      data: {
        total: count ?? 0,
        rows: rows.map((row) => ({
          id: row.id,
          domainName: row.domain_name,
          domainHref: row.domain_id ? adminHref.domain(row.domain_id) : null,
          kind: row.kind,
          ...driftComparison(row.kind, row.detail),
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          lastRun: row.last_run_id ? (runs.get(row.last_run_id) ?? null) : null,
        })),
      },
    }
  } catch (error) {
    return failed('drift', error)
  }
}

export type Heartbeat = {
  name: string
  side: AdminSide
  beatAt: string
  /** `detail.outcome`, and nothing else from the detail. */
  outcome: string | null
}

export type HeartbeatsRead = { ok: true; hidden: true } | Read<Heartbeat[]>

/**
 * Every background service's last heartbeat, both sides. `service_heartbeats`
 * has no side filter, so a test administrator is not shown it (§2.3) — and
 * is not asked about it either.
 */
export async function listHeartbeats(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<HeartbeatsRead> {
  if (admin.testOnly) return { ok: true, hidden: true }
  try {
    const { data, error } = await adminDb(admin, side)
      .from('service_heartbeats')
      .select('name, test_mode, beat_at, detail')
      .order('name', { ascending: true })
    if (error) return failed('heartbeats', error)
    return {
      ok: true,
      data: (data ?? []).map((row): Heartbeat => {
        const detail = row.detail as Record<string, unknown> | null
        const outcome = typeof detail?.outcome === 'string' ? detail.outcome.slice(0, 40) : null
        return {
          name: row.name,
          side: row.test_mode ? 'test' : 'live',
          beatAt: row.beat_at,
          outcome,
        }
      }),
    }
  } catch (error) {
    return failed('heartbeats', error)
  }
}

export type RunRow = {
  id: string
  startedAt: string
  finishedAt: string | null
  seconds: number | null
  domainsSeen: number | null
  findings: number | null
  /** "Done", "Running", or "Failed (API_301)" — never the error's message (N10). */
  outcome: { label: string; tone: Tone }
}

export type RunsSummary = {
  runs: number
  failed: number
  averageSeconds: number | null
  /** The last 20. */
  recent: RunRow[]
}

const DAY_MS = 86_400_000
export const RUN_DAYS = 7
export const RECENT_RUNS = 20

/** The side's registry checks over the last 7 days: how many, how many failed, how long. */
export async function getReconcileRuns(
  admin: AdminPrincipal,
  side: AdminSide,
  now: Date,
): Promise<Read<RunsSummary>> {
  const since = new Date(now.getTime() - RUN_DAYS * DAY_MS).toISOString()
  try {
    const { data, error } = await adminDb(admin, side)
      .from('reconcile_runs')
      .select('id, started_at, finished_at, domains_seen, findings, error')
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(1000)
    if (error) return failed('reconcile runs', error)
    const rows: RunRow[] = (data ?? []).map((run) => {
      const seconds =
        run.finished_at === null
          ? null
          : Math.max(0, (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000)
      return {
        id: run.id,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        seconds: Number.isFinite(seconds) ? seconds : null,
        domainsSeen: run.domains_seen,
        findings: run.findings,
        outcome: runOutcome({ finishedAt: run.finished_at, error: run.error }),
      }
    })
    const timed = rows.flatMap((row) => (row.seconds === null ? [] : [row.seconds]))
    return {
      ok: true,
      data: {
        runs: rows.length,
        failed: rows.filter((row) => row.outcome.tone === 'danger').length,
        averageSeconds:
          timed.length > 0 ? timed.reduce((sum, value) => sum + value, 0) / timed.length : null,
        recent: rows.slice(0, RECENT_RUNS),
      },
    }
  } catch (error) {
    return failed('reconcile runs', error)
  }
}

const cronSchema = z.object({
  job: z.string().min(1),
  schedule: z.string().catch(''),
  lastRunAt: when.optional().transform((value) => value ?? null),
  lastStatus: z
    .string()
    .nullable()
    .optional()
    .catch(null)
    .transform((value) => value ?? null),
  lastSuccessAt: when.optional().transform((value) => value ?? null),
})

export type CronJob = z.infer<typeof cronSchema>

/** Only the scheduled jobs are kept from the overview's answer. */
const overviewCronSchema = z.object({
  health: z.object({ cron: z.array(cronSchema).nullable().optional() }),
})

export type CronRead = { ok: true; hidden: true } | Read<CronJob[]>

/**
 * Each pg_cron job's schedule, last run and last success, from
 * `admin_overview.health.cron` (§5.2). SQL omits it for a test
 * administrator, and the page shows no panel for one, so it is not asked.
 */
export async function getCronHealth(admin: AdminPrincipal, side: AdminSide): Promise<CronRead> {
  if (admin.testOnly) return { ok: true, hidden: true }
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('admin_overview', { p_test_mode: side === 'test' })
    if (error) return failed('scheduled jobs', error)
    const parsed = overviewCronSchema.safeParse(data)
    if (!parsed.success) return failed('scheduled jobs', { code: 'shape' })
    return { ok: true, data: parsed.data.health.cron ?? [] }
  } catch (error) {
    return failed('scheduled jobs', error)
  }
}
