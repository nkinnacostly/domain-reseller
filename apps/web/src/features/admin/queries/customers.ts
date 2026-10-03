import 'server-only'

import {
  type CustomerDetail,
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
 * customer's orders, domains, certificates and emails come through `adminDb`
 * (orders and the masked views), by user id, on the side shown — and only after `admin_customer` has said this admin may
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

/** How many of the newest rows the Domains and Certificates tabs show; the Emails tab, fewer. */
export const TAB_ROWS_CAP = 100
export const TAB_EMAILS_SHOWN = 10

export type Capped<Row> = { rows: Row[]; total: number }

export type CustomerDomainRow = {
  id: string
  domainName: string
  status: string
  expiresAt: string | null
  autoRenew: boolean
  registeredAt: string | null
  createdAt: string
  testMode: boolean
}

/**
 * The customer's domains on the side, newest first, from `admin_domains_v`
 * by user id — the masked view, without the registrant or contacts (§9).
 * Demo rows are left out, as every count of a customer's domains leaves
 * them out.
 */
export async function listCustomerDomains(
  admin: AdminPrincipal,
  side: AdminSide,
  customer: ShownCustomer,
): Promise<Capped<CustomerDomainRow>> {
  const answer = await adminDb(admin, side)
    .from('admin_domains_v')
    .select(
      'id, domain_name, local_status, expires_at, auto_renew, registered_at, created_at, test_mode',
      { count: 'exact' },
    )
    .eq('user_id', customer.userId)
    .neq('source', 'demo')
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(TAB_ROWS_CAP)
  const rows = read('domains', answer) ?? []
  return {
    rows: rows.flatMap((row) =>
      row.id && row.domain_name
        ? [
            {
              id: row.id,
              domainName: row.domain_name,
              status: row.local_status ?? '',
              expiresAt: row.expires_at,
              autoRenew: row.auto_renew === true,
              registeredAt: row.registered_at,
              createdAt: row.created_at ?? '',
              testMode: row.test_mode === true,
            },
          ]
        : [],
    ),
    total: answer.count ?? rows.length,
  }
}

export type CustomerCertificateRow = {
  id: string
  name: string
  product: string | null
  status: string
  issuedAt: string | null
  expiresAt: string | null
  createdAt: string
  testMode: boolean
}

/**
 * The customer's certificates on the side, newest first, from
 * `admin_ssl_certificates_v` by user id: the name, product, status and
 * dates only (§9).
 */
export async function listCustomerCertificates(
  admin: AdminPrincipal,
  side: AdminSide,
  customer: ShownCustomer,
): Promise<Capped<CustomerCertificateRow>> {
  const answer = await adminDb(admin, side)
    .from('admin_ssl_certificates_v')
    .select('id, common_name, product_name, status, issued_at, expires_at, created_at, test_mode', {
      count: 'exact',
    })
    .eq('user_id', customer.userId)
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(TAB_ROWS_CAP)
  const rows = read('certificates', answer) ?? []
  return {
    rows: rows.flatMap((row) =>
      row.id
        ? [
            {
              id: row.id,
              name: row.common_name ?? '—',
              product: row.product_name,
              status: row.status ?? '',
              issuedAt: row.issued_at,
              expiresAt: row.expires_at,
              createdAt: row.created_at ?? '',
              testMode: row.test_mode === true,
            },
          ]
        : [],
    ),
    total: answer.count ?? rows.length,
  }
}

export type CustomerEmailRow = {
  id: string
  kind: string
  category: string
  status: string
  deliveryStatus: string | null
  createdAt: string
  sentAt: string | null
  testMode: boolean
}

/**
 * The newest emails queued for the customer on the side, from
 * `admin_email_outbox_v` by user id: what and when only. The recipient and
 * the provider's error, even masked, stay on the Emails page (§9), which
 * the tab links to by the account's id.
 */
export async function listCustomerEmails(
  admin: AdminPrincipal,
  side: AdminSide,
  customer: ShownCustomer,
): Promise<Capped<CustomerEmailRow>> {
  const answer = await adminDb(admin, side)
    .from('admin_email_outbox_v')
    .select('id, kind, category, status, delivery_status, created_at, sent_at, test_mode', {
      count: 'exact',
    })
    .eq('user_id', customer.userId)
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(TAB_EMAILS_SHOWN)
  const rows = read('emails', answer) ?? []
  return {
    rows: rows.flatMap((row) =>
      row.id
        ? [
            {
              id: row.id,
              kind: row.kind ?? '',
              category: row.category ?? '',
              status: row.status ?? '',
              deliveryStatus: row.delivery_status,
              createdAt: row.created_at ?? '',
              sentAt: row.sent_at,
              testMode: row.test_mode === true,
            },
          ]
        : [],
    ),
    total: answer.count ?? rows.length,
  }
}
