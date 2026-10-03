import 'server-only'

import { cache } from 'react'
import { z } from 'zod'
import { AdminRefusal } from '@/features/admin/lib/errors'
import { pageRange } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { CALL_SORT_COLUMN, type CallsSearch } from '@/features/admin/lib/supplier-calls'
import { heartbeatFrom, type SyncHeartbeat } from '@/features/admin/lib/supplier-catalogue'
import {
  type LedgerDay,
  parseLedgerDays,
  parseSupplierFloat,
  type SupplierFloat,
} from '@/features/admin/lib/supplier-data'
import {
  type ChainEntry,
  LEDGER_SORT_COLUMN,
  type LedgerSearch,
  lagosRange,
} from '@/features/admin/lib/supplier-ledger'
import type { TopupHistoryRow } from '@/features/admin/lib/supplier-topups'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { type AdminPrincipal, adminDb } from './session'

/**
 * The Supplier pages' reads (docs/ADMIN-SPEC.md §5.2 B6, D4). Aggregates are
 * SQL functions called as the admin — `admin_float`, `admin_ledger_daily`,
 * `admin_provisioning` — which check who is asking and refuse a test
 * administrator the live side themselves. Row lists come through `adminDb`,
 * which applies the side. Every read answers null when it could not be made,
 * so a page shows its error state rather than a wrong number.
 */

const warn = (error: unknown, what: string) =>
  logger.warn(
    {
      code:
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : error instanceof Error
            ? error.name
            : 'unknown',
    },
    what,
  )

/** `admin_float` for one side, once per request: the balance, burn, runway and top-ups. */
export const getSupplierFloat = cache(async (side: AdminSide): Promise<SupplierFloat | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_float', { p_test_mode: side === 'test' })
  if (error) {
    warn(error, 'admin float unavailable')
    return null
  }
  const parsed = parseSupplierFloat(data)
  if ('issues' in parsed) {
    logger.error({ issues: parsed.issues }, 'admin_float answered an unexpected shape')
    return null
  }
  return parsed
})

/** Settled debits, credits and the closing balance per Lagos day, from the mirror. */
export async function getLedgerDaily(
  side: AdminSide,
  from: string,
  to: string,
): Promise<LedgerDay[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_ledger_daily', {
    p_test_mode: side === 'test',
    p_from: from,
    p_to: to,
  })
  if (error) {
    warn(error, 'admin ledger daily unavailable')
    return null
  }
  const days = parseLedgerDays(data)
  if (!days) logger.error('admin_ledger_daily answered an unexpected shape')
  return days
}

/** The balance at each Lagos day's close, from the daily rollup (cents). */
export async function getBalanceCloses(
  admin: AdminPrincipal,
  side: AdminSide,
  from: string,
): Promise<{ day: string; closeCents: number }[] | null> {
  try {
    const { data, error } = await adminDb(admin, side)
      .from('metrics_daily')
      .select('day, value')
      .eq('metric', 'balance_close_cents')
      .gte('day', from)
      .order('day', { ascending: true })
      .limit(400)
    if (error) {
      warn(error, 'admin balance closes unavailable')
      return null
    }
    return (data ?? []).flatMap((row) =>
      typeof row.day === 'string' && Number.isSafeInteger(row.value)
        ? [{ day: row.day.slice(0, 10), closeCents: row.value }]
        : [],
    )
  } catch (error) {
    warn(error, 'admin balance closes refused')
    return null
  }
}

export type LedgerRow = {
  traceId: string
  occurredAt: string
  type: number
  status: number
  chargeType: number
  productType: number
  description: string
  period: number | null
  oldBalanceCents: number
  balanceCents: number
  deltaCents: number
  matchState: string
  matchCallId: number | null
  matchOperation: string | null
  matchOrderItemId: string | null
  matchedAt: string | null
}

const ledgerRowSchema = z.object({
  trace_id: z.string(),
  occurred_at: z.string(),
  type: z.number().int(),
  status: z.number().int(),
  charge_type: z.number().int(),
  product_type: z.number().int(),
  description: z.string(),
  period: z.number().int().nullable(),
  old_balance_cents: z.number().int(),
  balance_cents: z.number().int(),
  delta_cents: z.number().int(),
  match_state: z.string(),
  match_call_id: z.number().int().nullable(),
  match_operation: z.string().nullable(),
  match_order_item_id: z.string().nullable(),
  matched_at: z.string().nullable(),
})

function toLedgerRow(row: unknown): LedgerRow[] {
  const parsed = ledgerRowSchema.safeParse(row)
  if (!parsed.success) return []
  const r = parsed.data
  return [
    {
      traceId: r.trace_id,
      occurredAt: r.occurred_at,
      type: r.type,
      status: r.status,
      chargeType: r.charge_type,
      productType: r.product_type,
      description: r.description,
      period: r.period,
      oldBalanceCents: r.old_balance_cents,
      balanceCents: r.balance_cents,
      deltaCents: r.delta_cents,
      matchState: r.match_state,
      matchCallId: r.match_call_id,
      matchOperation: r.match_operation,
      matchOrderItemId: r.match_order_item_id,
      matchedAt: r.matched_at,
    },
  ]
}

/** One page of the mirror on the side, filtered as the URL says, with the total. */
export async function getLedgerPage(
  admin: AdminPrincipal,
  side: AdminSide,
  params: LedgerSearch,
): Promise<{ rows: LedgerRow[]; total: number } | null> {
  try {
    let query = adminDb(admin, side)
      .from('supplier_ledger_entries')
      .select(
        'trace_id, occurred_at, type, status, charge_type, product_type, description, period, old_balance_cents, balance_cents, delta_cents, match_state, match_call_id, match_operation, match_order_item_id, matched_at',
        { count: 'exact' },
      )
    if (params.status.length > 0) query = query.in('match_state', params.status)
    if (params.trace) query = query.eq('trace_id', params.trace)
    const range = lagosRange(params.from, params.to)
    if (range.gte) query = query.gte('occurred_at', range.gte)
    if (range.lt) query = query.lt('occurred_at', range.lt)
    const { from, to } = pageRange(params)
    const { data, error, count } = await query
      .order(LEDGER_SORT_COLUMN[params.sort], { ascending: params.dir === 'asc' })
      .order('trace_id', { ascending: params.dir === 'asc' })
      .range(from, to)
    if (error) {
      warn(error, 'admin ledger unavailable')
      return null
    }
    return { rows: (data ?? []).flatMap(toLedgerRow), total: count ?? 0 }
  } catch (error) {
    warn(error, 'admin ledger refused')
    return null
  }
}

export type LedgerRevision = {
  id: number
  traceId: string
  seenAt: string
  changes: unknown
  applied: boolean
}

/** Every revision of the entries on a page, newest first: what the supplier changed. */
export async function getLedgerRevisions(
  admin: AdminPrincipal,
  side: AdminSide,
  traceIds: readonly string[],
): Promise<Map<string, LedgerRevision[]> | null> {
  const byTrace = new Map<string, LedgerRevision[]>()
  if (traceIds.length === 0) return byTrace
  try {
    const { data, error } = await adminDb(admin, side)
      .from('supplier_ledger_revisions')
      .select('id, trace_id, seen_at, changes, applied')
      .in('trace_id', [...traceIds])
      .order('seen_at', { ascending: false })
      .limit(500)
    if (error) {
      warn(error, 'admin ledger revisions unavailable')
      return null
    }
    for (const row of data ?? []) {
      if (typeof row.trace_id !== 'string' || typeof row.id !== 'number') continue
      const list = byTrace.get(row.trace_id) ?? []
      list.push({
        id: row.id,
        traceId: row.trace_id,
        seenAt: row.seen_at,
        changes: row.changes,
        applied: row.applied === true,
      })
      byTrace.set(row.trace_id, list)
    }
    return byTrace
  } catch (error) {
    warn(error, 'admin ledger revisions refused')
    return null
  }
}

/** How many of the latest entries the chain strip checks. */
export const CHAIN_DEPTH = 200

/** The latest entries' balances, for the chain strip: newest first from SQL. */
export async function getLedgerChain(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<ChainEntry[] | null> {
  try {
    const { data, error } = await adminDb(admin, side)
      .from('supplier_ledger_entries')
      .select('trace_id, occurred_at, description, old_balance_cents, balance_cents')
      .order('occurred_at', { ascending: false })
      .order('trace_id', { ascending: false })
      .limit(CHAIN_DEPTH)
    if (error) {
      warn(error, 'admin ledger chain unavailable')
      return null
    }
    return (data ?? []).flatMap((row) =>
      Number.isSafeInteger(row.old_balance_cents) && Number.isSafeInteger(row.balance_cents)
        ? [
            {
              traceId: row.trace_id,
              occurredAt: row.occurred_at,
              description: row.description ?? '',
              oldBalanceCents: row.old_balance_cents,
              balanceCents: row.balance_cents,
            },
          ]
        : [],
    )
  } catch (error) {
    warn(error, 'admin ledger chain refused')
    return null
  }
}

/** Every record of what top-ups cost, corrections included (live side only). */
export async function getTopupHistory(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<TopupHistoryRow[] | null> {
  try {
    const { data, error } = await adminDb(admin, side)
      .from('float_topups')
      .select('id, trace_id, ngn_paid_kobo, reference, supersedes_id, recorded_by, recorded_at')
      .order('recorded_at', { ascending: false })
      .limit(500)
    if (error) {
      warn(error, 'admin top-up history unavailable')
      return null
    }
    return (data ?? []).map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      ngnPaidKobo: row.ngn_paid_kobo,
      reference: row.reference,
      supersedesId: row.supersedes_id,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
    }))
  } catch (error) {
    warn(error, 'admin top-up history refused')
    return null
  }
}

/** The active costing rate (₦ per $), for comparing a top-up's own rate; public data. */
export async function getCostingRate(admin: AdminPrincipal): Promise<number | null> {
  try {
    const { data, error } = await adminDb(admin, 'live')
      .from('fx_rates')
      .select('costing_rate, effective_from')
      .eq('status', 'active')
      .order('effective_from', { ascending: false })
      .limit(1)
    if (error) {
      warn(error, 'admin costing rate unavailable')
      return null
    }
    const rate = Number(data?.[0]?.costing_rate)
    return Number.isFinite(rate) && rate > 0 ? rate : null
  } catch (error) {
    warn(error, 'admin costing rate refused')
    return null
  }
}

export type CallRow = {
  id: number
  createdAt: string
  operation: string
  outcome: string
  domainName: string | null
  errorCode: string | null
  httpStatus: number | null
  durationMs: number
  jobId: string | null
  sslJobId: string | null
}

/** One page of recorded provisioning calls on the side's environment, with the total. */
export async function getCalls(
  admin: AdminPrincipal,
  side: AdminSide,
  params: CallsSearch,
): Promise<{ rows: CallRow[]; total: number } | null> {
  try {
    let query = adminDb(admin, side)
      .from('supplier_calls')
      .select(
        'id, created_at, operation, outcome, domain_name, error_code, http_status, duration_ms, job_id, ssl_job_id',
        { count: 'exact' },
      )
    if (params.status.length > 0) query = query.in('outcome', params.status)
    if (params.op) query = query.eq('operation', params.op)
    if (params.job) query = query.eq('job_id', params.job)
    const range = lagosRange(params.from, params.to)
    if (range.gte) query = query.gte('created_at', range.gte)
    if (range.lt) query = query.lt('created_at', range.lt)
    const { from, to } = pageRange(params)
    const { data, error, count } = await query
      .order(CALL_SORT_COLUMN[params.sort], { ascending: params.dir === 'asc' })
      .order('id', { ascending: params.dir === 'asc' })
      .range(from, to)
    if (error) {
      warn(error, 'admin supplier calls unavailable')
      return null
    }
    return {
      rows: (data ?? []).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        operation: row.operation,
        outcome: row.outcome,
        domainName: row.domain_name,
        errorCode: row.error_code,
        httpStatus: row.http_status,
        durationMs: row.duration_ms,
        jobId: row.job_id,
        sslJobId: row.ssl_job_id,
      })),
      total: count ?? 0,
    }
  } catch (error) {
    warn(error, 'admin supplier calls refused')
    return null
  }
}

const callSummarySchema = z.object({
  calls: z.array(
    z.object({
      operation: z.string(),
      outcome: z.string(),
      count: z.number().int().nonnegative(),
      p50Ms: z.number().nullable(),
      p95Ms: z.number().nullable(),
    }),
  ),
})

export type CallSummaryRow = z.infer<typeof callSummarySchema>['calls'][number]

/** Calls by operation and outcome over a range, with their median and 95th-percentile times. */
export async function getCallSummary(
  side: AdminSide,
  from: string,
  to: string,
): Promise<CallSummaryRow[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_provisioning', {
    p_test_mode: side === 'test',
    p_from: from,
    p_to: to,
  })
  if (error) {
    warn(error, 'admin provisioning summary unavailable')
    return null
  }
  const parsed = callSummarySchema.safeParse(data)
  if (!parsed.success) {
    logger.error('admin_provisioning answered an unexpected shape')
    return null
  }
  return [...parsed.data.calls].sort(
    (a, b) => b.count - a.count || a.operation.localeCompare(b.operation),
  )
}

/** The weekly syncs' last runs, or 'hidden' for a test administrator (§2.3: heartbeats are not theirs). */
export const getSyncHeartbeats = cache(async function getSyncHeartbeats(
  admin: AdminPrincipal,
): Promise<{ tlds: SyncHeartbeat | null; ssl: SyncHeartbeat | null } | 'hidden' | null> {
  if (admin.testOnly) return 'hidden'
  try {
    const { data, error } = await adminDb(admin, 'live')
      .from('service_heartbeats')
      .select('name, beat_at, detail')
      .in('name', ['catalogue:production', 'ssl_catalogue:production'])
    if (error) {
      warn(error, 'admin sync heartbeats unavailable')
      return null
    }
    const named = (name: string) => (data ?? []).find((row) => row.name === name) ?? null
    return {
      tlds: heartbeatFrom(named('catalogue:production')),
      ssl: heartbeatFrom(named('ssl_catalogue:production')),
    }
  } catch (error) {
    if (error instanceof AdminRefusal && error.adminCode === 'TEST_ADMIN') return 'hidden'
    warn(error, 'admin sync heartbeats refused')
    return null
  }
})
