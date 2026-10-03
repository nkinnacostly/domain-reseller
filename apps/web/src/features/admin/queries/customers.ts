import 'server-only'

import {
  type CustomerDetail,
  type CustomerLine,
  type CustomerRow,
  type CustomerStats,
  parseCustomer,
  parseCustomerStats,
  toCustomerRow,
} from '@/features/admin/lib/customers-data'
import { type CustomerListParams, customerFilter } from '@/features/admin/lib/customers-params'
import { AdminRefusal, adminAccessError } from '@/features/admin/lib/errors'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The customers pages' reads (docs/ADMIN-SPEC.md §5.2, B8). Who a customer
 * is comes only from the admin_* functions, which mask the email and keep a
 * test admin to e2e accounts (D4, D15); nothing here reads a profile. A
 * customer's orders and their lines come through `adminDb`, by user id, on
 * the side shown — and only after `admin_customer` has said this admin may
 * see the account. Logs carry codes and counts, never an id, email or
 * domain (N13).
 */

export class CustomersReadError extends Error {
  constructor(readonly what: string) {
    super(`admin customers: could not read ${what}`)
    this.name = 'CustomersReadError'
  }
}

type Answer = { data: unknown; error: { code?: string; message: string } | null }
type Read<A extends Answer> = Extract<A, { error: null }>['data']

function read<A extends Answer>(what: string, answer: A): Read<A> {
  if (answer.error) {
    // The code only: a message can quote the value that was looked for (N13).
    logger.warn({ what, code: answer.error.code }, 'admin customers read failed')
    throw new CustomersReadError(what)
  }
  return answer.data as Read<A>
}

/** The side a read is on: a test admin's is always Test, as adminDb and SQL hold (D15). */
const sideFor = (admin: AdminPrincipal, side: AdminSide): AdminSide =>
  admin.testOnly ? 'test' : side

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Totals ─────────────────────────────────────────────────────────────────

export type StatsResult =
  | { kind: 'ok'; stats: CustomerStats }
  | { kind: 'hidden' }
  | { kind: 'error' }

/**
 * `admin_customer_stats()`: real accounts, live side. It refuses a test
 * admin, so a test admin is not asked at all (§5.2: "Not shown to test
 * administrators").
 */
export async function getCustomerStats(admin: AdminPrincipal): Promise<StatsResult> {
  if (admin.testOnly) return { kind: 'hidden' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_customer_stats')
  if (error) {
    logger.warn({ code: error.code }, 'admin customers: totals unavailable')
    return { kind: 'error' }
  }
  const stats = parseCustomerStats(data)
  return stats ? { kind: 'ok', stats } : { kind: 'error' }
}

// ── The list ───────────────────────────────────────────────────────────────

export type CustomerList = { rows: CustomerRow[]; total: number }

/**
 * One page of `admin_customers`, sorted and paged in SQL. Counts are on the
 * side shown; a test admin gets e2e accounts only. Past the last page SQL
 * answers no rows, and so no total: the page says so and links back.
 */
export async function listCustomers(
  admin: AdminPrincipal,
  side: AdminSide,
  params: CustomerListParams,
): Promise<CustomerList> {
  const supabase = await createClient()
  const answer = await supabase.rpc('admin_customers', {
    p_test_mode: sideFor(admin, side) === 'test',
    p_sort: params.sort,
    p_dir: params.dir,
    p_offset: (params.page - 1) * params.per,
    p_limit: params.per,
    p_filter: customerFilter(params),
  })
  const rows = read('customers', answer) ?? []
  return {
    rows: rows.map(toCustomerRow),
    total: Number(rows[0]?.total_count ?? 0),
  }
}

// ── One customer ───────────────────────────────────────────────────────────

export type CustomerLookup =
  | { kind: 'ok'; customer: CustomerDetail }
  | { kind: 'not_found' }
  | { kind: 'test_admin' }

/**
 * `admin_customer`: the masked account and its counts on the side shown.
 * Every other read of this customer waits on it, because it is SQL that
 * keeps a test admin to e2e accounts (D15) — adminDb alone would show a test
 * admin a real customer's test orders.
 */
export async function getCustomer(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<CustomerLookup> {
  if (!UUID.test(id)) return { kind: 'not_found' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_customer', {
    p_user_id: id.toLowerCase(),
    p_test_mode: sideFor(admin, side) === 'test',
  })
  if (error) {
    const refusal = adminAccessError(error.message)
    if (refusal instanceof AdminRefusal && refusal.adminCode === 'test_admin') {
      return { kind: 'test_admin' }
    }
    logger.warn({ code: error.code }, 'admin customers read failed')
    throw new CustomersReadError('the customer')
  }
  if (data === null) return { kind: 'not_found' }
  const customer = parseCustomer(data)
  if (!customer) throw new CustomersReadError('the customer')
  return { kind: 'ok', customer }
}

/** A customer the page has already been allowed to show (getCustomer said `ok`). */
export type ShownCustomer = { userId: string }

// ── Their orders ───────────────────────────────────────────────────────────

const RANGE_NOT_SATISFIABLE = 'PGRST103'
export const ORDERS_PER_PAGE = 25

export type CustomerOrder = {
  id: string
  orderNumber: string
  testMode: boolean
  status: string
  totalKobo: number
  createdAt: string
  paidAt: string | null
  invoiceNumber: string | null
  kinds: string[]
}

export type CustomerOrders = { rows: CustomerOrder[]; total: number }

/** A page of the customer's orders on the side, newest first, with what each bought. */
export async function listCustomerOrders(
  admin: AdminPrincipal,
  side: AdminSide,
  customer: ShownCustomer,
  page: number,
): Promise<CustomerOrders> {
  const db = adminDb(admin, side)
  const from = (page - 1) * ORDERS_PER_PAGE
  const answer = await db
    .from('admin_orders_v')
    .select(
      'id, order_number, test_mode, status, total_kobo, created_at, paid_at, invoice_number',
      { count: 'exact' },
    )
    .eq('user_id', customer.userId)
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + ORDERS_PER_PAGE - 1)
  if (answer.error?.code === RANGE_NOT_SATISFIABLE) {
    // Past the last page PostgREST refuses the range (416): count what there is instead.
    const counted = await db
      .from('admin_orders_v')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', customer.userId)
    read('the order count', counted)
    return { rows: [], total: counted.count ?? 0 }
  }
  const orders = read('orders', answer) ?? []
  const ids = orders.map((order) => order.id).filter((id): id is string => id !== null)
  const lines =
    ids.length === 0
      ? []
      : (read(
          'order lines',
          await db.from('order_items').select('order_id, item_type').in('order_id', ids),
        ) ?? [])
  const rows: CustomerOrder[] = orders.flatMap((order) =>
    order.id === null
      ? []
      : [
          {
            id: order.id,
            orderNumber: order.order_number ?? '—',
            testMode: order.test_mode === true,
            status: order.status ?? '',
            totalKobo: Number(order.total_kobo ?? 0),
            createdAt: order.created_at ?? '',
            paidAt: order.paid_at,
            invoiceNumber: order.invoice_number,
            kinds: lines.filter((line) => line.order_id === order.id).map((line) => line.item_type),
          },
        ],
  )
  return { rows, total: answer.count ?? rows.length }
}

/** How many of the newest orders the domain and certificate tabs read lines from. */
export const LINE_ORDERS_CAP = 100

export type CustomerLines = { lines: CustomerLine[]; capped: boolean }

/**
 * The lines of the customer's newest orders on the side, for the Domains and
 * Certificates tabs: what was bought, renewed or transferred, and each
 * line's state. Read by order id in one run (at most 100 ids, the
 * address-length rule for `.in()`).
 */
export async function listCustomerLines(
  admin: AdminPrincipal,
  side: AdminSide,
  customer: ShownCustomer,
): Promise<CustomerLines> {
  const db = adminDb(admin, side)
  const answer = await db
    .from('admin_orders_v')
    .select('id, order_number', { count: 'exact' })
    .eq('user_id', customer.userId)
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(LINE_ORDERS_CAP)
  const orders = read('orders', answer) ?? []
  const numbers = new Map(
    orders.flatMap((order) => (order.id ? [[order.id, order.order_number] as const] : [])),
  )
  const ids = [...numbers.keys()]
  if (ids.length === 0) return { lines: [], capped: false }
  const rows =
    read(
      'order lines',
      await db
        .from('order_items')
        .select('id, order_id, domain, domain_id, item_type, status, ssl_product_code, created_at')
        .in('order_id', ids)
        .order('created_at', { ascending: false }),
    ) ?? []
  return {
    lines: rows.map((line) => ({
      id: line.id,
      orderId: line.order_id,
      orderNumber: numbers.get(line.order_id) ?? null,
      domain: line.domain,
      domainId: line.domain_id,
      itemType: line.item_type,
      status: line.status,
      sslProductCode: line.ssl_product_code,
      createdAt: line.created_at,
    })),
    capped: (answer.count ?? orders.length) > LINE_ORDERS_CAP,
  }
}

/** Certificate products' names by code (the storefront's own list). */
export async function sslProductNames(
  admin: AdminPrincipal,
  side: AdminSide,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(codes)]
  if (wanted.length === 0) return new Map()
  const rows =
    read(
      'certificate products',
      await adminDb(admin, side)
        .from('ssl_products')
        .select('product_code, name')
        .in('product_code', wanted),
    ) ?? []
  return new Map(
    rows.flatMap((row) => (row.name ? [[String(row.product_code), row.name] as const] : [])),
  )
}
