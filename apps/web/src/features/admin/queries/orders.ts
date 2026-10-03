import 'server-only'

import { z } from 'zod'
import {
  nextDay,
  ORDER_SORT_COLUMN,
  type OrderListParams,
  watDayStart,
} from '@/features/admin/lib/orders-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminDb, type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { chunk, IDS_PER_READ } from '@/features/domains/lib/chunks'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The orders pages' reads (docs/ADMIN-SPEC.md §5.2, B2). Rows come through
 * `adminDb`, which applies the Live/Test side itself; orders through
 * `admin_orders_v` (no registrant or contacts), payments through
 * `admin_payments_v` (the fee without the raw answer), and a line's cost from
 * the service-only `order_item_costs` (D13). The customer is the masked email
 * `admin_customers` gives (D4); nothing here reads a profile. Logs carry
 * codes and counts only — never a search, a domain or an email (N13).
 */

export class OrdersReadError extends Error {
  constructor(readonly what: string) {
    super(`admin orders: could not read ${what}`)
    this.name = 'OrdersReadError'
  }
}

type Answer = { data: unknown; error: { code?: string; message: string } | null }
/** What a read answers when it worked: rows, or one row or null from `maybeSingle()`. */
type Read<A extends Answer> = Extract<A, { error: null }>['data']

function read<A extends Answer>(what: string, answer: A): Read<A> {
  if (answer.error) {
    // The code only: a message can quote the value that was looked for (N13).
    logger.warn({ what, code: answer.error.code }, 'admin orders read failed')
    throw new OrdersReadError(what)
  }
  return answer.data as Read<A>
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** The side a read is on: a test admin's is always Test, as adminDb and SQL hold (D15). */
const sideFor = (admin: AdminPrincipal, side: AdminSide): AdminSide =>
  admin.testOnly ? 'test' : side

/** At most this many orders an id filter (kind, domain, stuck) hands to the list. */
export const ORDER_ID_CAP = IDS_PER_READ
/** How many order lines a kind or domain filter scans for their orders. */
const LINE_SCAN = 1000
/** How many settling orders the stuck filter looks at, oldest payment first. */
const STUCK_SCAN = 500
/** How many pages of customers are read to mask a page's buyers. */
const CUSTOMER_PAGES = 5
const CUSTOMERS_PER_PAGE = 100

// ── The masked customer ────────────────────────────────────────────────────

/**
 * Each buyer's masked email (`a•••@gmail.com`) from `admin_customers`, the
 * one read that may name a customer here (§9). It has no filter by id, so
 * it is paged until every buyer is found. A buyer not found — a real
 * customer's test order seen by a test admin, or past the pages read — is
 * left out, and the page shows the account's short id instead.
 */
export async function maskedCustomers(
  side: AdminSide,
  userIds: readonly (string | null)[],
): Promise<Map<string, string | null>> {
  const wanted = new Set(userIds.filter((id): id is string => id !== null))
  const found = new Map<string, string | null>()
  if (wanted.size === 0) return found
  const supabase = await createClient()
  for (let page = 0; page < CUSTOMER_PAGES && found.size < wanted.size; page += 1) {
    const { data, error } = await supabase.rpc('admin_customers', {
      p_test_mode: side === 'test',
      p_sort: 'joined',
      p_dir: 'desc',
      p_offset: page * CUSTOMERS_PER_PAGE,
      p_limit: CUSTOMERS_PER_PAGE,
      p_filter: {},
    })
    if (error) {
      // The buyer is a courtesy here: the orders still show without it.
      logger.warn({ code: error.code }, 'admin orders: customers unavailable')
      break
    }
    const rows = data ?? []
    for (const row of rows) {
      if (wanted.has(row.user_id)) found.set(row.user_id, row.masked_email ?? null)
    }
    if (rows.length < CUSTOMERS_PER_PAGE) break
  }
  return found
}

// ── The list ───────────────────────────────────────────────────────────────

export type OrderListRow = {
  id: string
  orderNumber: string
  testMode: boolean
  createdAt: string
  paidAt: string | null
  userId: string | null
  /** The masked email; undefined when the buyer was not found. */
  customer: string | null | undefined
  status: string
  totalKobo: number
  invoiceNumber: string | null
  floatCheck: string | null
  lines: { item_type: string }[]
}

/** Why the stuck filter listed every settling order: its threshold is a setting a test admin cannot read. */
export type StuckNote = 'test_admin' | 'no_threshold' | null

export type OrderList = {
  rows: OrderListRow[]
  total: number
  /** An id filter matched more than one read takes: only the newest are listed. */
  capped: boolean
  stuckNote: StuckNote
}

type IdSet = { ids: string[]; capped: boolean }

/** Orders with a line of this kind, newest first, within the list's dates. */
async function orderIdsByKind(db: AdminDb, params: OrderListParams): Promise<IdSet> {
  let query = db
    .from('order_items')
    .select('order_id, created_at')
    .eq('item_type', params.kind ?? '')
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayStart(nextDay(params.to)))
  const rows = read(
    'lines by kind',
    await query.order('created_at', { ascending: false }).limit(LINE_SCAN),
  )
  return { ids: unique(rows.map((row) => row.order_id)), capped: rows.length >= LINE_SCAN }
}

/** Orders with a line for this domain (its ASCII form), newest first. */
async function orderIdsByDomain(db: AdminDb, domain: string): Promise<IdSet> {
  const rows = read(
    'lines by domain',
    await db
      .from('order_items')
      .select('order_id, created_at')
      .eq('domain', domain)
      .order('created_at', { ascending: false })
      .limit(LINE_SCAN),
  )
  return { ids: unique(rows.map((row) => row.order_id)), capped: rows.length >= LINE_SCAN }
}

/** The order of one line (`?line=`, from a `ledger_missing` alert). */
async function orderIdsByLine(db: AdminDb, line: string): Promise<IdSet> {
  const rows = read(
    'the line',
    await db.from('order_items').select('order_id').eq('id', line).limit(1),
  )
  return { ids: rows.map((row) => row.order_id), capped: false }
}

/**
 * Stuck, as SQL counts it for the sidebar and the `order_stuck` alert: paid
 * or provisioning, paid longer ago than `ops_settings.stuck_order_minutes`,
 * with a line still pending or provisioning — a transfer the other registrar
 * is still releasing is not late (migration 26). A test admin cannot read
 * the settings (§2.3), so for one every settling order is listed, and said so.
 */
async function stuckOrderIds(
  admin: AdminPrincipal,
  db: AdminDb,
  now: Date,
): Promise<IdSet & { note: StuckNote }> {
  let minutes: number | null = null
  if (!admin.testOnly) {
    const settings = read(
      'the stuck-order threshold',
      await db.from('ops_settings').select('stuck_order_minutes').limit(1),
    )
    minutes = settings[0]?.stuck_order_minutes ?? null
  }
  let query = db
    .from('admin_orders_v')
    .select('id, paid_at')
    .in('status', ['paid', 'provisioning'])
    .not('paid_at', 'is', null)
  if (minutes !== null) {
    query = query.lt('paid_at', new Date(now.getTime() - minutes * 60_000).toISOString())
  }
  const candidates = read(
    'settling orders',
    await query.order('paid_at', { ascending: true }).limit(STUCK_SCAN),
  )
  const ids = candidates.map((row) => row.id).filter((id): id is string => id !== null)

  const unsettled: { id: string; order_id: string; item_type: string }[] = []
  for (const run of chunk(ids, IDS_PER_READ)) {
    unsettled.push(
      ...read(
        'unsettled lines',
        await db
          .from('order_items')
          .select('id, order_id, item_type')
          .in('order_id', run)
          .in('status', ['pending', 'provisioning']),
      ),
    )
  }
  const transfers = unsettled.filter((line) => line.item_type === 'transfer').map((l) => l.id)
  const waiting = new Set<string>()
  for (const run of chunk(transfers, IDS_PER_READ)) {
    const rows = read(
      'transfers waiting',
      await db
        .from('admin_domains_v')
        .select('order_item_id')
        .in('order_item_id', run)
        .eq('local_status', 'transfer_pending'),
    )
    for (const row of rows) if (row.order_item_id) waiting.add(row.order_item_id)
  }
  const late = new Set(
    unsettled.filter((line) => !waiting.has(line.id)).map((line) => line.order_id),
  )
  return {
    ids: ids.filter((id) => late.has(id)),
    capped: candidates.length >= STUCK_SCAN,
    note: admin.testOnly ? 'test_admin' : minutes === null ? 'no_threshold' : null,
  }
}

/** The orders in every set, in the first set's order. */
function intersect(sets: IdSet[]): IdSet | null {
  const [head, ...rest] = sets
  if (!head) return null
  const others = rest.map((set) => new Set(set.ids))
  const ids = head.ids.filter((id) => others.every((set) => set.has(id)))
  return {
    ids: ids.slice(0, ORDER_ID_CAP),
    capped: sets.some((set) => set.capped) || ids.length > ORDER_ID_CAP,
  }
}

/** PostgREST's answer to a page past the end (HTTP 416). */
const RANGE_NOT_SATISFIABLE = 'PGRST103'

/** The filters a page of orders and its count share. */
type Narrowable<Q> = {
  in(column: string, values: readonly string[]): Q
  eq(column: string, value: string): Q
  gte(column: string, value: string): Q
  lt(column: string, value: string): Q
}

function narrow<Q extends Narrowable<Q>>(start: Q, params: OrderListParams, only: IdSet | null): Q {
  let query = start
  if (params.status.length > 0) query = query.in('status', params.status)
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayStart(nextDay(params.to)))
  if (only) query = query.in('id', only.ids)
  // Exact matches only, on values classifyOrderSearch has already shaped.
  if (params.search.kind === 'order_number') query = query.eq('order_number', params.search.value)
  if (params.search.kind === 'tx_ref') query = query.eq('tx_ref', params.search.value)
  if (params.search.kind === 'invoice') query = query.eq('invoice_number', params.search.value)
  return query
}

/**
 * One page of orders on the side, with each order's lines and buyer. An
 * email or an unreadable search is never looked up (N13): the list is empty.
 */
export async function listOrders(
  admin: AdminPrincipal,
  side: AdminSide,
  params: OrderListParams,
  now: Date = new Date(),
): Promise<OrderList> {
  const empty: OrderList = { rows: [], total: 0, capped: false, stuckNote: null }
  if (params.search.kind === 'email' || params.search.kind === 'unknown') return empty
  const db = adminDb(admin, side)
  const onSide = sideFor(admin, side)

  const sets: IdSet[] = []
  let stuckNote: StuckNote = null
  if (params.line) sets.push(await orderIdsByLine(db, params.line))
  if (params.search.kind === 'domain') sets.push(await orderIdsByDomain(db, params.search.value))
  if (params.kind) sets.push(await orderIdsByKind(db, params))
  if (params.stuck) {
    const stuck = await stuckOrderIds(admin, db, now)
    stuckNote = stuck.note
    sets.push(stuck)
  }
  const only = intersect(sets)
  const capped = only?.capped ?? false
  if (only && only.ids.length === 0) return { ...empty, capped, stuckNote }

  const from = (params.page - 1) * params.per
  const answer = await narrow(
    db
      .from('admin_orders_v')
      .select(
        'id, order_number, test_mode, created_at, paid_at, user_id, status, total_kobo, invoice_number, float_check',
        { count: 'exact' },
      ),
    params,
    only,
  )
    .order(ORDER_SORT_COLUMN[params.sort], { ascending: params.dir === 'asc', nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + params.per - 1)
  if (answer.error?.code === RANGE_NOT_SATISFIABLE) {
    // Past the last page PostgREST refuses the range (416): count what there is instead.
    const counted = await narrow(
      db.from('admin_orders_v').select('id', { count: 'exact', head: true }),
      params,
      only,
    )
    read('the order count', counted)
    return { rows: [], total: counted.count ?? 0, capped, stuckNote }
  }
  const orders = read('orders', answer)
  const total = answer.count ?? orders.length

  const ids = orders.map((order) => order.id).filter((id): id is string => id !== null)
  const lines =
    ids.length === 0
      ? []
      : read(
          'order lines',
          await db.from('order_items').select('order_id, item_type').in('order_id', ids),
        )
  const customers = await maskedCustomers(
    onSide,
    orders.map((order) => order.user_id),
  )

  const rows: OrderListRow[] = orders.flatMap((order) =>
    order.id === null
      ? []
      : [
          {
            id: order.id,
            orderNumber: order.order_number ?? '—',
            testMode: order.test_mode === true,
            createdAt: order.created_at ?? '',
            paidAt: order.paid_at,
            userId: order.user_id,
            customer: order.user_id ? customers.get(order.user_id) : undefined,
            status: order.status ?? '',
            totalKobo: Number(order.total_kobo ?? 0),
            invoiceNumber: order.invoice_number,
            floatCheck: order.float_check,
            lines: lines.filter((line) => line.order_id === order.id),
          },
        ],
  )
  return { rows, total, capped, stuckNote }
}

// ── The funnel ─────────────────────────────────────────────────────────────

const count = z.coerce.number().int().nonnegative().catch(0)
const seconds = z.number().nonnegative().nullable().catch(null)

const funnelSchema = z.object({
  cartAdds: count,
  cartAddsSince: z.string().nullable().catch(null),
  created: count,
  paid: count,
  completed: count,
  partial: count,
  failed: count,
  cancelled: count,
  awaiting: count,
  inFlight: count,
  medianSecsToPay: seconds,
  medianSecsToSettle: seconds,
})

export type OrderFunnel = z.infer<typeof funnelSchema>

/** The side's funnel over WAT days, from SQL (`admin_funnel`); null when it could not be read. */
export async function getOrderFunnel(
  side: AdminSide,
  range: { from: string; to: string },
): Promise<OrderFunnel | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_funnel', {
    p_test_mode: side === 'test',
    p_from: range.from,
    p_to: range.to,
  })
  if (error) {
    logger.warn({ code: error.code }, 'admin orders: funnel unavailable')
    return null
  }
  const parsed = funnelSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

// ── One order ──────────────────────────────────────────────────────────────

/** A part of the order page that read, or did not: the rest still shows. */
export type Section<T> = { ok: true; data: T } | { ok: false }

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await load() }
  } catch (error) {
    if (!(error instanceof OrdersReadError)) {
      logger.warn({ name: error instanceof Error ? error.name : 'unknown' }, 'admin orders failed')
    }
    return { ok: false }
  }
}

export type OrderSummary = {
  id: string
  orderNumber: string
  testMode: boolean
  status: string
  createdAt: string
  updatedAt: string | null
  paidAt: string | null
  paymentCheckedAt: string | null
  userId: string | null
  customer: string | null | undefined
  subtotalKobo: number
  vatKobo: number
  vatPct: number | null
  totalKobo: number
  invoiceNumber: string | null
  txRef: string | null
  floatCheck: string | null
  nameservers: string[] | null
}

export type OrderLine = {
  id: string
  itemType: string
  domain: string
  periodYears: number
  priceKobo: number
  renewalKobo: number
  renewalYears: number | null
  status: string
  failureCode: string | null
  autoRenew: boolean
  privacy: boolean
  /** The domain record this line made or renewed, when there is one. */
  domainId: string | null
  cost: { supplier_cost_cents: number; icann_fee_cents: number; recorded_at: string } | null
  jobIds: string[]
}

export type OrderPayment = {
  id: string
  providerReference: string | null
  amountKobo: number | null
  chargedKobo: number | null
  feeKobo: number | null
  absorbed: boolean | null
  status: string | null
  method: string | null
  createdAt: string | null
}

export type OrderRefund = {
  id: string
  reason: string
  status: string
  amountKobo: number
  orderItemId: string | null
  createdAt: string
  completedAt: string | null
  lastErrorCode: string | null
}

export type OrderIncident = {
  id: number
  kind: string
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

export type OrderJob = {
  id: string
  kind: string
  status: string
  attempts: number
  orderItemId: string | null
  createdAt: string
  finishedAt: string | null
  lastErrorCode: string | null
}

export type SupplierCall = {
  id: number
  createdAt: string
  operation: string
  outcome: string
  httpStatus: number | null
  durationMs: number
  errorCode: string | null
  jobId: string | null
}

export type DomainEvent = {
  id: number
  domainId: string
  eventType: string
  actorType: string
  createdAt: string
}

export type OrderDetail = {
  order: OrderSummary
  lines: Section<OrderLine[]>
  payments: Section<OrderPayment[]>
  refunds: Section<OrderRefund[]>
  incidents: Section<OrderIncident[]>
  trace: Section<{ jobs: OrderJob[]; calls: SupplierCall[] }>
  activity: Section<{ events: DomainEvent[]; domains: Map<string, string> }>
}

/** The newest supplier calls an order page shows. */
export const CALLS_SHOWN = 100
/** The newest domain events an order page shows. */
export const EVENTS_SHOWN = 50

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function readLines(db: AdminDb, orderId: string) {
  const lines = read(
    'order lines',
    await db
      .from('order_items')
      .select(
        'id, item_type, domain, period_years, price_kobo, renewal_kobo, renewal_years, status, failure_code, auto_renew, privacy, domain_id, created_at',
      )
      .eq('order_id', orderId)
      .order('created_at', { ascending: true }),
  )
  const ids = lines.map((line) => line.id)
  const [costs, jobs, domains] = await Promise.all([
    ids.length === 0
      ? []
      : read(
          'line costs',
          await db
            .from('order_item_costs')
            .select('order_item_id, supplier_cost_cents, icann_fee_cents, recorded_at')
            .in('order_item_id', ids),
        ),
    ids.length === 0
      ? []
      : read(
          'jobs',
          await db
            .from('jobs')
            .select(
              'id, kind, status, attempts, order_item_id, created_at, finished_at, last_error_code',
            )
            .in('order_item_id', ids)
            .order('created_at', { ascending: true }),
        ),
    ids.length === 0
      ? []
      : read(
          'domains',
          await db
            .from('admin_domains_v')
            .select('id, domain_name, order_item_id')
            .in('order_item_id', ids),
        ),
  ])
  return { lines, costs, jobs, domains }
}

/**
 * One order on the side, with each part of its page read separately so one
 * failed read leaves the others standing. Null when the id is not an order
 * on this side.
 */
export async function getOrderDetail(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<OrderDetail | null> {
  if (!UUID.test(id)) return null
  const db = adminDb(admin, side)
  const onSide = sideFor(admin, side)
  const order = read(
    'the order',
    await db
      .from('admin_orders_v')
      .select(
        'id, order_number, test_mode, status, created_at, updated_at, paid_at, payment_checked_at, user_id, subtotal_kobo, vat_kobo, vat_pct, total_kobo, invoice_number, tx_ref, float_check, nameservers',
      )
      .eq('id', id.toLowerCase())
      .maybeSingle(),
  )
  if (!order?.id) return null
  const orderId = order.id

  const linesRead = readLines(db, orderId)
  const [lineSection, payments, refunds, incidents, customers] = await Promise.all([
    section(async () => {
      const { lines, costs, jobs, domains } = await linesRead
      const domainByLine = new Map(
        domains.flatMap((row): [string, string][] =>
          row.order_item_id && row.id ? [[row.order_item_id, row.id]] : [],
        ),
      )
      return lines.map(
        (line): OrderLine => ({
          id: line.id,
          itemType: line.item_type,
          domain: line.domain,
          periodYears: line.period_years,
          priceKobo: Number(line.price_kobo),
          renewalKobo: Number(line.renewal_kobo),
          renewalYears: line.renewal_years,
          status: line.status,
          failureCode: line.failure_code,
          autoRenew: line.auto_renew,
          privacy: line.privacy,
          domainId: line.domain_id ?? domainByLine.get(line.id) ?? null,
          cost: costs.find((cost) => cost.order_item_id === line.id) ?? null,
          jobIds: jobs.filter((job) => job.order_item_id === line.id).map((job) => job.id),
        }),
      )
    }),
    section(async () =>
      read(
        'payments',
        await db
          .from('admin_payments_v')
          .select(
            'id, provider_reference, amount_kobo, charged_kobo, fee_kobo, absorbed, status, method, created_at',
          )
          .eq('order_id', orderId)
          .order('created_at', { ascending: true }),
      ).flatMap((row): OrderPayment[] =>
        row.id === null
          ? []
          : [
              {
                id: row.id,
                providerReference: row.provider_reference,
                amountKobo: row.amount_kobo,
                chargedKobo: row.charged_kobo,
                feeKobo: row.fee_kobo,
                absorbed: row.absorbed,
                status: row.status,
                method: row.method,
                createdAt: row.created_at,
              },
            ],
      ),
    ),
    section(async () =>
      read(
        'refunds',
        await db
          .from('refunds')
          .select(
            'id, reason, status, amount_kobo, order_item_id, created_at, completed_at, last_error_code',
          )
          .eq('order_id', orderId)
          .order('created_at', { ascending: true }),
      ).map(
        (row): OrderRefund => ({
          id: row.id,
          reason: row.reason,
          status: row.status,
          amountKobo: Number(row.amount_kobo),
          orderItemId: row.order_item_id,
          createdAt: row.created_at,
          completedAt: row.completed_at,
          lastErrorCode: row.last_error_code,
        }),
      ),
    ),
    section(async () =>
      read(
        'payment incidents',
        await db
          .from('payment_incidents')
          .select('id, kind, created_at, resolved_at, resolved_by')
          .eq('order_id', orderId)
          .order('created_at', { ascending: true }),
      ).map(
        (row): OrderIncident => ({
          id: row.id,
          kind: row.kind,
          createdAt: row.created_at,
          resolvedAt: row.resolved_at,
          resolvedBy: row.resolved_by,
        }),
      ),
    ),
    maskedCustomers(onSide, [order.user_id]),
  ])

  const [trace, activity] = await Promise.all([
    section(async () => {
      const { jobs } = await linesRead
      const jobIds = jobs.map((job) => job.id)
      const calls =
        jobIds.length === 0
          ? []
          : read(
              'supplier calls',
              await db
                .from('supplier_calls')
                .select(
                  'id, created_at, operation, outcome, http_status, duration_ms, error_code, job_id',
                )
                .in('job_id', jobIds)
                .order('created_at', { ascending: false })
                .limit(CALLS_SHOWN),
            )
      return {
        jobs: jobs.map(
          (job): OrderJob => ({
            id: job.id,
            kind: job.kind,
            status: job.status,
            attempts: job.attempts,
            orderItemId: job.order_item_id,
            createdAt: job.created_at,
            finishedAt: job.finished_at,
            lastErrorCode: job.last_error_code,
          }),
        ),
        calls: calls.map(
          (call): SupplierCall => ({
            id: call.id,
            createdAt: call.created_at,
            operation: call.operation,
            outcome: call.outcome,
            httpStatus: call.http_status,
            durationMs: call.duration_ms,
            errorCode: call.error_code,
            jobId: call.job_id,
          }),
        ),
      }
    }),
    section(async () => {
      const { lines, domains } = await linesRead
      const names = new Map<string, string>()
      for (const row of domains) if (row.id) names.set(row.id, row.domain_name ?? '')
      for (const line of lines) if (line.domain_id) names.set(line.domain_id, line.domain)
      const domainIds = [...names.keys()]
      const events =
        domainIds.length === 0
          ? []
          : read(
              'domain events',
              await db
                .from('domain_events')
                .select('id, domain_id, event_type, actor_type, created_at')
                .in('domain_id', domainIds)
                .gte('created_at', order.created_at ?? new Date(0).toISOString())
                .order('created_at', { ascending: false })
                .limit(EVENTS_SHOWN),
            )
      return {
        domains: names,
        events: events.map(
          (event): DomainEvent => ({
            id: event.id,
            domainId: event.domain_id,
            eventType: event.event_type,
            actorType: event.actor_type,
            createdAt: event.created_at,
          }),
        ),
      }
    }),
  ])

  return {
    order: {
      id: orderId,
      orderNumber: order.order_number ?? '—',
      testMode: order.test_mode === true,
      status: order.status ?? '',
      createdAt: order.created_at ?? '',
      updatedAt: order.updated_at,
      paidAt: order.paid_at,
      paymentCheckedAt: order.payment_checked_at,
      userId: order.user_id,
      customer: order.user_id ? customers.get(order.user_id) : undefined,
      subtotalKobo: Number(order.subtotal_kobo ?? 0),
      vatKobo: Number(order.vat_kobo ?? 0),
      vatPct: order.vat_pct === null ? null : Number(order.vat_pct),
      totalKobo: Number(order.total_kobo ?? 0),
      invoiceNumber: order.invoice_number,
      txRef: order.tx_ref,
      floatCheck: order.float_check,
      nameservers: order.nameservers,
    },
    lines: lineSection,
    payments,
    refunds,
    incidents,
    trace,
    activity,
  }
}
