import type { RouteTab } from '@/features/admin/components/route-tabs'
import { adminHref } from '@/features/admin/lib/href'
import {
  type ListParams,
  type ListSpec,
  listHref,
  parseListParams,
} from '@/features/admin/lib/list-params'

/**
 * The customers list's URL (docs/ADMIN-SPEC.md §5.2, B8): sort, direction,
 * page and page size, plus three filters SQL `admin_customers` takes. None of
 * it ever names a person — a customer is found by email only through the
 * POST search, never `?q=` (N13, §1). Parsing is strict: anything unknown
 * falls back to the unfiltered list.
 */

export const CUSTOMER_SORTS = ['joined', 'domains', 'orders', 'paid', 'last_sign_in'] as const
export type CustomerSort = (typeof CUSTOMER_SORTS)[number]

export const CUSTOMER_SORT_LABEL: Record<CustomerSort, string> = {
  joined: 'Joined',
  domains: 'Domains held',
  orders: 'Orders paid',
  paid: 'Total paid',
  last_sign_in: 'Last sign-in',
}

export const CUSTOMER_LIST_SPEC: ListSpec<CustomerSort> = {
  sorts: CUSTOMER_SORTS,
  defaultSort: 'joined',
  defaultDir: 'desc',
  perOptions: [25, 50, 100],
  defaultPer: 25,
}

export const HOLDER_FILTERS = ['yes', 'no'] as const
export const TWO_FACTOR_FILTERS = ['on', 'off'] as const
export const ACCOUNT_TYPES = ['individual', 'business'] as const

export type HolderFilter = (typeof HOLDER_FILTERS)[number]
export type TwoFactorFilter = (typeof TWO_FACTOR_FILTERS)[number]
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const HOLDER_LABEL: Record<HolderFilter, string> = {
  yes: 'Holds domains',
  no: 'No domains',
}
export const TWO_FACTOR_LABEL: Record<TwoFactorFilter, string> = { on: '2FA on', off: '2FA off' }
export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  individual: 'Individual',
  business: 'Business',
}

export type CustomerListParams = ListParams<CustomerSort> & {
  holders: HolderFilter | null
  twofa: TwoFactorFilter | null
  type: AccountType | null
}

type Search = Record<string, string | string[] | undefined> | URLSearchParams

function first(search: Search, key: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | null {
  return (values as readonly string[]).includes(value ?? '') ? (value as T) : null
}

export function parseCustomerListParams(search: Search): CustomerListParams {
  return {
    ...parseListParams(search, CUSTOMER_LIST_SPEC),
    holders: oneOf(HOLDER_FILTERS, first(search, 'holders')),
    twofa: oneOf(TWO_FACTOR_FILTERS, first(search, 'twofa')),
    type: oneOf(ACCOUNT_TYPES, first(search, 'type')),
  }
}

type Changes = Partial<CustomerListParams>

/**
 * The list with some values changed. Any change but the page goes back to
 * page 1; defaults stay out of the URL (list-params' rule).
 */
export function customersHref(params: CustomerListParams, changes: Changes = {}): string {
  const { holders, twofa, type, ...list } = { ...params, ...changes }
  const restart = changes.page === undefined && Object.keys(changes).length > 0
  return listHref(
    '/admin/customers',
    { ...list, page: restart ? 1 : list.page },
    CUSTOMER_LIST_SPEC,
    {
      extra: { holders, twofa, type },
    },
  )
}

/** Whether any filter narrows the list (an empty list then says "no match", not "none yet"). */
export function isFiltered(params: CustomerListParams): boolean {
  return params.holders !== null || params.twofa !== null || params.type !== null
}

/** `admin_customers`' `p_filter`: only the keys set, so SQL reads the rest as "any". */
export function customerFilter(params: CustomerListParams): Record<string, string | boolean> {
  return {
    ...(params.holders ? { holders: params.holders === 'yes' } : {}),
    ...(params.twofa ? { hasTotp: params.twofa === 'on' } : {}),
    ...(params.type ? { accountType: params.type } : {}),
  }
}

// ── One customer's tabs ────────────────────────────────────────────────────

export const CUSTOMER_TABS = ['overview', 'domains', 'orders', 'certificates', 'emails'] as const
export type CustomerTab = (typeof CUSTOMER_TABS)[number]

export const CUSTOMER_TAB_LABEL: Record<CustomerTab, string> = {
  overview: 'Overview',
  domains: 'Domains',
  orders: 'Orders',
  certificates: 'Certificates',
  emails: 'Emails',
}

/** A tab's address, built from the checked id (adminHref) — the list when the id is not one. */
export function customerTabHref(id: string, tab: CustomerTab): string {
  const base = adminHref.customer(id)
  if (tab === 'overview' || base === '/admin/customers') return base
  return `${base}/${tab}`
}

/** The tabs, the orders one with its count on this side. */
export function customerTabs(id: string, counts: { orders?: number } = {}): RouteTab[] {
  return CUSTOMER_TABS.map((tab) => ({
    href: customerTabHref(id, tab),
    label: CUSTOMER_TAB_LABEL[tab],
    ...(tab === 'overview' ? { exact: true } : {}),
    ...(tab === 'orders' && counts.orders !== undefined ? { count: counts.orders } : {}),
  }))
}

/** `?page=` on a tab that pages; anything else is page 1. */
export function tabPage(search: Search): number {
  const text = first(search, 'page') ?? '1'
  return /^\d{1,5}$/.test(text) ? Math.max(1, Number(text)) : 1
}
