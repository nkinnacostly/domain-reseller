import {
  type ListParams,
  type ListSpec,
  listHref,
  parseListParams,
} from '@/features/admin/lib/list-params'
import { toAsciiHost } from '@/features/search/lib/idn'

/**
 * The orders list's URL (docs/ADMIN-SPEC.md §5.2, B2): the shared
 * `?status=&from=&to=&sort=&dir=&page=&per=`, plus `kind`, `stuck=1`,
 * `line=<order_item_id>` and the search box's `q`. Everything is parsed
 * strictly: an unknown value falls back to the default rather than reaching
 * a query.
 *
 * `q` takes an order number, a payment reference, an invoice number or a
 * domain — never an email. An email in a URL stays in history and logs
 * (N13); customers are found by email on the Customers page, with a POST.
 */

export const ORDER_SORTS = ['placed', 'total', 'paid'] as const
export type OrderSort = (typeof ORDER_SORTS)[number]

export const ORDER_STATUSES = [
  'awaiting_payment',
  'paid',
  'provisioning',
  'completed',
  'partially_failed',
  'failed',
  'cancelled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/** What an order line buys; an order's kinds are its lines'. */
export const ORDER_KINDS = ['register', 'renew', 'transfer', 'ssl'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]

export const ORDER_KIND_LABEL: Record<OrderKind, string> = {
  register: 'Registration',
  renew: 'Renewal',
  transfer: 'Transfer in',
  ssl: 'Certificate',
}

export const ORDER_LIST_SPEC: ListSpec<OrderSort, OrderStatus> = {
  sorts: ORDER_SORTS,
  defaultSort: 'placed',
  defaultDir: 'desc',
  statuses: ORDER_STATUSES,
}

/** The column each sort orders by; `placed` is the default, newest first. */
export const ORDER_SORT_COLUMN: Record<OrderSort, 'created_at' | 'total_kobo' | 'paid_at'> = {
  placed: 'created_at',
  total: 'total_kobo',
  paid: 'paid_at',
}

export const ORDER_SORT_LABEL: Record<OrderSort, string> = {
  placed: 'Placed',
  total: 'Total',
  paid: 'Paid',
}

/** What the search box was given, and how it is looked up — exactly, never as a pattern. */
export type OrderSearch =
  | { kind: 'none' }
  | { kind: 'order_number'; value: string }
  | { kind: 'tx_ref'; value: string }
  | { kind: 'invoice'; value: string }
  | { kind: 'domain'; value: string }
  /** Refused: an email is never searched here, and never kept in a link. */
  | { kind: 'email' }
  /** Nothing an order can be found by. */
  | { kind: 'unknown' }

const ORDER_NUMBER = /^nd-(\d{1,12})$/i
const TX_REF = /^mdh-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const INVOICE = /^((?:test-)?inv)-(\d{1,12})$/i
const HOST =
  /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The longest search the box sends (its `maxLength`). */
export const ORDER_SEARCH_MAX = 120

/**
 * Reads the search box. Order and invoice numbers are matched as SQL writes
 * them (`ND-001035`, `TEST-INV-000001`); a payment reference is `MDH-` and a
 * lower-case uuid; a domain is its ASCII form, lower-cased (FR-S8).
 */
export function classifyOrderSearch(input: string | null | undefined): OrderSearch {
  const text = (input ?? '').trim()
  if (text === '') return { kind: 'none' }
  if (text.includes('@')) return { kind: 'email' }
  if (text.length > ORDER_SEARCH_MAX) return { kind: 'unknown' }
  const order = ORDER_NUMBER.exec(text)
  if (order?.[1]) return { kind: 'order_number', value: `ND-${order[1].padStart(6, '0')}` }
  const tx = TX_REF.exec(text)
  if (tx?.[1]) return { kind: 'tx_ref', value: `MDH-${tx[1].toLowerCase()}` }
  const invoice = INVOICE.exec(text)
  if (invoice?.[1] && invoice[2]) {
    return {
      kind: 'invoice',
      value: `${invoice[1].toUpperCase()}-${invoice[2].padStart(6, '0')}`,
    }
  }
  const host = toAsciiHost(text.replace(/\.$/, ''))
  if (host && HOST.test(host)) return { kind: 'domain', value: host }
  return { kind: 'unknown' }
}

export type OrderListParams = ListParams<OrderSort, OrderStatus> & {
  kind: OrderKind | null
  /** Only orders paid and still settling past the stuck-order threshold. */
  stuck: boolean
  /** One order line's order (`ledger_missing` alerts link here). */
  line: string | null
  /** The search as typed, for the box — empty when it was an email. */
  q: string
  search: OrderSearch
}

type Search = Record<string, string | string[] | undefined> | URLSearchParams

function first(search: Search, key: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

export function parseOrderListParams(search: Search): OrderListParams {
  const base = parseListParams(search, ORDER_LIST_SPEC)
  const kindText = first(search, 'kind')
  const kind = (ORDER_KINDS as readonly string[]).includes(kindText ?? '')
    ? (kindText as OrderKind)
    : null
  const lineText = first(search, 'line')
  const line = lineText && UUID.test(lineText) ? lineText.toLowerCase() : null
  const searchResult = classifyOrderSearch(first(search, 'q'))
  const q = searchResult.kind === 'email' ? '' : (first(search, 'q') ?? '').trim()
  return {
    ...base,
    kind,
    stuck: first(search, 'stuck') === '1',
    line,
    q: q.slice(0, ORDER_SEARCH_MAX),
    search: searchResult,
  }
}

/** True when the list is narrowed by anything but its sort and page. */
export function isFiltered(params: OrderListParams): boolean {
  return (
    params.status.length > 0 ||
    params.from !== null ||
    params.to !== null ||
    params.kind !== null ||
    params.stuck ||
    params.line !== null ||
    params.search.kind !== 'none'
  )
}

type OrderChanges = Partial<ListParams<OrderSort, OrderStatus>> & {
  kind?: OrderKind | null
  stuck?: boolean
  line?: string | null
  q?: string
}

/**
 * A link to the list with some values changed, keeping the rest. An email
 * is never carried into a link (`q` is empty for one), and changing a filter
 * goes back to page 1.
 */
export function ordersHref(params: OrderListParams, changes: OrderChanges = {}): string {
  const { kind, stuck, line, q, ...rest } = changes
  const extrasChanged = kind !== undefined || stuck !== undefined || line !== undefined
  const searchChanged = q !== undefined
  const nextQ = q ?? params.q
  const listChanges =
    (extrasChanged || searchChanged) && rest.page === undefined ? { ...rest, page: 1 } : rest
  return listHref('/admin/orders', params, ORDER_LIST_SPEC, {
    ...listChanges,
    extra: {
      kind: kind === undefined ? params.kind : kind,
      stuck: (stuck ?? params.stuck) ? '1' : null,
      line: line === undefined ? params.line : line,
      q: nextQ === '' ? null : nextQ,
    },
  })
}

/** Toggling one status chip. */
export function toggleStatus(params: OrderListParams, status: OrderStatus): OrderStatus[] {
  return params.status.includes(status)
    ? params.status.filter((value) => value !== status)
    : [...params.status, status]
}

/** Lagos midnight at the start of a `YYYY-MM-DD` day (WAT is UTC+1, with no daylight saving). */
export function watDayStart(day: string): string {
  return `${day}T00:00:00+01:00`
}

/** The day after a `YYYY-MM-DD` day. */
export function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** Today in Lagos, `YYYY-MM-DD`. */
export function watToday(now: Date): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** The funnel's range: the list's dates, or the 30 days to today (WAT). */
export function funnelRange(
  params: Pick<OrderListParams, 'from' | 'to'>,
  now: Date,
): { from: string; to: string } {
  const today = watToday(now)
  const to = params.to ?? (params.from && params.from > today ? params.from : today)
  if (params.from) return { from: params.from, to }
  const start = new Date(`${to}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - 29)
  return { from: start.toISOString().slice(0, 10), to }
}
