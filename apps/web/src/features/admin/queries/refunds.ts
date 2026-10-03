import 'server-only'

import { z } from 'zod'
import { type ListParams, pageRange } from '@/features/admin/lib/list-params'
import {
  type IncidentListParams,
  REFUND_SORT_COLUMN,
  type RefundReason,
  type RefundSort,
  type RefundStatus,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/refunds-rules'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The refunds pages' reads (ADMIN-SPEC §5.2 B3). Rows come through adminDb,
 * which applies the side; aggregates and the automatic limits come from
 * `admin_refund_stats`, called as the admin, which refuses a test admin the
 * live side itself. Nothing here selects a payment's raw answer, a contact
 * or a provider's free-text error: codes, ids, statuses and kobo only — and
 * from `admin_payments_v`, the charge's reference alone (§9).
 */

type Failed = { ok: false }
const FAILED: Failed = { ok: false }

/** A read failed: the code goes to the log, never a row (N13). */
function failed(what: string, error: { code?: string; message?: string } | null): Failed {
  logger.warn({ code: error?.code ?? null }, `admin refunds: ${what} could not be read`)
  return FAILED
}

// ── Stats and limits ──────────────────────────────────────────────────────

const kobo = z.coerce.number().int().catch(0)

const statsSchema = z.object({
  byReasonStatus: z
    .array(
      z.object({
        reason: z.string(),
        status: z.string(),
        count: z.coerce.number().int().nonnegative(),
        amountKobo: kobo,
      }),
    )
    .catch([]),
  openOldestAt: z.string().nullable().catch(null),
  medianHoursToComplete: z.coerce.number().nullable().catch(null),
  sent24hKobo: kobo,
  limits: z.object({
    singleKobo: z.coerce.number().int(),
    dailyKobo: z.coerce.number().int(),
    delayMinutes: z.coerce.number().int(),
  }),
})

export type RefundStats = z.infer<typeof statsSchema>

/**
 * Counts by reason and status, the oldest open refund, the median time to
 * complete, what was sent in 24 hours, and the automatic limits as the
 * database holds them now. Null when it could not be read: the limits are
 * never guessed, so the dialogs that quote them are not offered.
 */
export async function getRefundStats(side: AdminSide): Promise<RefundStats | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_refund_stats', {
    p_test_mode: side === 'test',
  })
  if (error) {
    failed('stats', error)
    return null
  }
  const parsed = statsSchema.safeParse(data)
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues.length },
      'admin refunds: stats had an unexpected shape',
    )
    return null
  }
  return parsed.data
}

// ── The list ──────────────────────────────────────────────────────────────

export type RefundRow = {
  id: string
  createdAt: string
  updatedAt: string
  orderId: string
  orderNumber: string | null
  reason: string
  status: string
  amountKobo: number
  lastErrorCode: string | null
  attempts: number
  testMode: boolean
}

export type RefundListQuery = ListParams<RefundSort, RefundStatus> & {
  reasons: RefundReason[]
  /** An order number in its stored form, from `?q=`. */
  orderNumber: string | null
}

type RefundListRow = {
  id: string
  created_at: string
  updated_at: string
  order_id: string
  reason: string
  status: string
  amount_kobo: number
  last_error_code: string | null
  attempts: number
  test_mode: boolean
}

/** Order numbers for a page of orders, by id. */
async function orderNumbers(
  admin: AdminPrincipal,
  side: AdminSide,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const { data, error } = await adminDb(admin, side)
    .from('admin_orders_v')
    .select('id, order_number')
    .in('id', unique)
  if (error) {
    failed('order numbers', error)
    return new Map()
  }
  return new Map(
    (data ?? []).flatMap((row) =>
      row.id && row.order_number ? [[row.id, row.order_number] as const] : [],
    ),
  )
}

/** The order with this number on this side, or null. */
async function orderIdFor(
  admin: AdminPrincipal,
  side: AdminSide,
  orderNumber: string,
): Promise<string | null | Failed> {
  const { data, error } = await adminDb(admin, side)
    .from('admin_orders_v')
    .select('id')
    .eq('order_number', orderNumber)
    .limit(1)
  if (error) return failed('order lookup', error)
  return data?.[0]?.id ?? null
}

/** A page of refunds on one side, filtered and sorted by the URL. */
export async function listRefunds(
  admin: AdminPrincipal,
  side: AdminSide,
  params: RefundListQuery,
): Promise<{ ok: true; rows: RefundRow[]; total: number } | Failed> {
  let orderId: string | null = null
  if (params.orderNumber) {
    const found = await orderIdFor(admin, side, params.orderNumber)
    if (found !== null && typeof found === 'object') return found
    if (found === null) return { ok: true, rows: [], total: 0 }
    orderId = found
  }

  let query = adminDb(admin, side)
    .from('refunds')
    .select(
      'id, created_at, updated_at, order_id, reason, status, amount_kobo, last_error_code, attempts, test_mode',
      { count: 'exact' },
    )
  if (params.status.length > 0) query = query.in('status', params.status)
  if (params.reasons.length > 0) query = query.in('reason', params.reasons)
  if (orderId) query = query.eq('order_id', orderId)
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayEnd(params.to))
  const { from, to } = pageRange(params)
  const { data, error, count } = await query
    .order(REFUND_SORT_COLUMN[params.sort], { ascending: params.dir === 'asc' })
    .order('id', { ascending: true })
    .range(from, to)
  if (error) return failed('list', error)

  const rows = (data ?? []) as RefundListRow[]
  const numbers = await orderNumbers(
    admin,
    side,
    rows.map((row) => row.order_id),
  )
  return {
    ok: true,
    total: count ?? rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      orderId: row.order_id,
      orderNumber: numbers.get(row.order_id) ?? null,
      reason: row.reason,
      status: row.status,
      amountKobo: Number(row.amount_kobo),
      lastErrorCode: row.last_error_code,
      attempts: row.attempts,
      testMode: row.test_mode,
    })),
  }
}

// ── One refund ────────────────────────────────────────────────────────────

export type RefundEvent = {
  id: number
  at: string
  event: string
  actor: string
  detail: Record<string, unknown>
}

export type RefundDetail = {
  id: string
  createdAt: string
  updatedAt: string
  reason: string
  status: string
  amountKobo: number
  lastErrorCode: string | null
  attempts: number
  runAfter: string
  approvedAt: string | null
  approvedBy: string | null
  completedAt: string | null
  submittedAt: string | null
  providerCalledAt: string | null
  providerRefundId: string | null
  providerStatus: string | null
  failedProviderRefundIds: string[]
  paymentId: string
  /** The charge's Flutterwave transaction id (`admin_payments_v.provider_reference`). */
  providerReference: string | null
  testMode: boolean
  order: {
    id: string
    orderNumber: string | null
    status: string | null
    totalKobo: number | null
    paidAt: string | null
    txRef: string | null
  }
  line: {
    id: string
    domain: string
    itemType: string
    status: string
    priceKobo: number
    periodYears: number
  } | null
  events: RefundEvent[]
}

type RefundDetailRow = {
  id: string
  created_at: string
  updated_at: string
  order_id: string
  order_item_id: string | null
  payment_id: string
  reason: string
  status: string
  amount_kobo: number
  last_error_code: string | null
  attempts: number
  run_after: string
  approved_at: string | null
  approved_by: string | null
  completed_at: string | null
  submitted_at: string | null
  provider_called_at: string | null
  provider_refund_id: string | null
  provider_status: string | null
  failed_provider_refund_ids: string[] | null
  test_mode: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * A refund on this side with its order, its line and its events, newest
 * first — or null when there is none here (another side, or no such id).
 */
export async function getRefund(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<{ ok: true; refund: RefundDetail | null } | Failed> {
  if (!UUID.test(id)) return { ok: true, refund: null }
  const db = adminDb(admin, side)
  const { data, error } = await db
    .from('refunds')
    .select(
      'id, created_at, updated_at, order_id, order_item_id, payment_id, reason, status, amount_kobo, last_error_code, attempts, run_after, approved_at, approved_by, completed_at, submitted_at, provider_called_at, provider_refund_id, provider_status, failed_provider_refund_ids, test_mode',
    )
    .eq('id', id.toLowerCase())
    .maybeSingle()
  if (error) return failed('refund', error)
  if (!data) return { ok: true, refund: null }
  const row = data as RefundDetailRow

  const [order, line, events, payment] = await Promise.all([
    db
      .from('admin_orders_v')
      .select('id, order_number, status, total_kobo, paid_at, tx_ref')
      .eq('id', row.order_id)
      .maybeSingle(),
    row.order_item_id
      ? db
          .from('order_items')
          .select('id, domain, item_type, status, price_kobo, period_years')
          .eq('id', row.order_item_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db
      .from('refund_events')
      .select('id, created_at, event, actor, detail')
      .eq('refund_id', row.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(100),
    // The charge's reference only: what a Flutterwave check must be on (§9).
    db
      .from('admin_payments_v')
      .select('id, provider_reference')
      .eq('id', row.payment_id)
      .maybeSingle(),
  ])
  if (order.error) return failed('order', order.error)
  if (line.error) return failed('line', line.error)
  if (events.error) return failed('events', events.error)
  if (payment.error) return failed('payment', payment.error)

  const lineRow = line.data as {
    id: string
    domain: string
    item_type: string
    status: string
    price_kobo: number
    period_years: number
  } | null

  return {
    ok: true,
    refund: {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reason: row.reason,
      status: row.status,
      amountKobo: Number(row.amount_kobo),
      lastErrorCode: row.last_error_code,
      attempts: row.attempts,
      runAfter: row.run_after,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      completedAt: row.completed_at,
      submittedAt: row.submitted_at,
      providerCalledAt: row.provider_called_at,
      providerRefundId: row.provider_refund_id,
      providerStatus: row.provider_status,
      failedProviderRefundIds: row.failed_provider_refund_ids ?? [],
      paymentId: row.payment_id,
      providerReference: payment.data?.provider_reference ?? null,
      testMode: row.test_mode,
      order: {
        id: row.order_id,
        orderNumber: order.data?.order_number ?? null,
        status: order.data?.status ?? null,
        totalKobo: order.data?.total_kobo ?? null,
        paidAt: order.data?.paid_at ?? null,
        txRef: order.data?.tx_ref ?? null,
      },
      line: lineRow
        ? {
            id: lineRow.id,
            domain: lineRow.domain,
            itemType: lineRow.item_type,
            status: lineRow.status,
            priceKobo: Number(lineRow.price_kobo),
            periodYears: lineRow.period_years,
          }
        : null,
      events: (
        (events.data ?? []) as {
          id: number
          created_at: string
          event: string
          actor: string
          detail: unknown
        }[]
      ).map((event) => ({
        id: event.id,
        at: event.created_at,
        event: event.event,
        actor: event.actor,
        detail: asRecord(event.detail),
      })),
    },
  }
}

// ── Payment incidents ─────────────────────────────────────────────────────

export type CompletedRefund = { id: string; amountKobo: number; completedAt: string | null }

export type IncidentRow = {
  id: number
  createdAt: string
  kind: string
  orderId: string | null
  orderNumber: string | null
  providerReference: string | null
  detail: Record<string, unknown>
  resolvedAt: string | null
  resolvedBy: string | null
  testMode: boolean
  /** Completed refunds on the incident's order: the evidence a "refund completed" outcome names. */
  completedRefunds: CompletedRefund[]
}

type IncidentDbRow = {
  id: number
  created_at: string
  kind: string
  order_id: string | null
  provider_reference: string | null
  detail: unknown
  resolved_at: string | null
  resolved_by: string | null
  test_mode: boolean
}

/** A page of payment incidents on one side: unresolved by default, newest first. */
export async function listIncidents(
  admin: AdminPrincipal,
  side: AdminSide,
  params: IncidentListParams,
): Promise<{ ok: true; rows: IncidentRow[]; total: number } | Failed> {
  const db = adminDb(admin, side)
  let query = db
    .from('payment_incidents')
    .select(
      'id, created_at, kind, order_id, provider_reference, detail, resolved_at, resolved_by, test_mode',
      { count: 'exact' },
    )
  // One incident by its number is shown whether or not it is resolved.
  if (params.id !== null) query = query.eq('id', params.id)
  else if (params.state === 'open') query = query.is('resolved_at', null)
  else if (params.state === 'resolved') query = query.not('resolved_at', 'is', null)
  if (params.kinds.length > 0) query = query.in('kind', params.kinds)
  const { from, to } = pageRange(params)
  const { data, error, count } = await query
    .order('created_at', { ascending: params.dir === 'asc' })
    .order('id', { ascending: params.dir === 'asc' })
    .range(from, to)
  if (error) return failed('incidents', error)
  const rows = (data ?? []) as IncidentDbRow[]

  const orderIds = [...new Set(rows.flatMap((row) => (row.order_id ? [row.order_id] : [])))]
  const [numbers, completed] = await Promise.all([
    orderNumbers(admin, side, orderIds),
    orderIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db
          .from('refunds')
          .select('id, order_id, amount_kobo, completed_at')
          .eq('status', 'completed')
          .in('order_id', orderIds)
          .order('completed_at', { ascending: false }),
  ])
  if (completed.error) return failed('completed refunds', completed.error)
  const byOrder = new Map<string, CompletedRefund[]>()
  for (const refund of (completed.data ?? []) as {
    id: string
    order_id: string
    amount_kobo: number
    completed_at: string | null
  }[]) {
    const list = byOrder.get(refund.order_id) ?? []
    list.push({
      id: refund.id,
      amountKobo: Number(refund.amount_kobo),
      completedAt: refund.completed_at,
    })
    byOrder.set(refund.order_id, list)
  }

  return {
    ok: true,
    total: count ?? rows.length,
    rows: rows.map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      kind: row.kind,
      orderId: row.order_id,
      orderNumber: row.order_id ? (numbers.get(row.order_id) ?? null) : null,
      providerReference: row.provider_reference,
      detail: asRecord(row.detail),
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      testMode: row.test_mode,
      completedRefunds: row.order_id ? (byOrder.get(row.order_id) ?? []) : [],
    })),
  }
}

/** How many incidents on this side are unresolved, for the tab; null when unknown. */
export async function countOpenIncidents(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<number | null> {
  const { count, error } = await adminDb(admin, side)
    .from('payment_incidents')
    .select('id', { count: 'exact', head: true })
    .is('resolved_at', null)
  if (error) {
    failed('incident count', error)
    return null
  }
  return count ?? 0
}
