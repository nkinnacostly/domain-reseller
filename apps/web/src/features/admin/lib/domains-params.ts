import type { LocalStatus } from '@dr/shared'
import {
  type ListParams,
  type ListSpec,
  listHref,
  parseListParams,
} from '@/features/admin/lib/list-params'
import { toAsciiHost } from '@/features/search/lib/idn'

/**
 * The domains list's URL (docs/ADMIN-SPEC.md §5.2, B9): the shared
 * `?status=&from=&to=&sort=&dir=&page=&per=` (dates are when the domain was
 * added), plus `tld`, `expires`, `delegation`, `renew`, `source` and the
 * search box's `q`. Every value is parsed strictly: an unknown one falls
 * back to the unfiltered list rather than reaching a query.
 *
 * `q` takes a domain or part of one — never an email. An email in a URL
 * stays in history and logs (N13); customers are found on Customers, by POST.
 */

export const DOMAIN_SORTS = ['expires', 'added', 'name', 'checked'] as const
export type DomainSort = (typeof DOMAIN_SORTS)[number]

/** Every `domains.local_status` (the `domain_status` enum), in lifecycle order. */
export const DOMAIN_STATUSES = [
  'pending',
  'active',
  'expired_grace',
  'redemption',
  'pending_delete',
  'pending_verification',
  'transfer_requested',
  'transfer_pending',
  'transfer_rejected',
  'transfer_cancelled',
  'registration_failed',
  'released',
  'transferred_away',
  'closed',
] as const satisfies readonly LocalStatus[]
export type DomainStatus = (typeof DOMAIN_STATUSES)[number]

/**
 * The statuses a domain is still ours and alive in: what `admin_domain_stats`
 * counts expiries and delegation over, and what a deep sync may read
 * (`admin_queue_deep_sync`'s NOT_SYNCABLE rule).
 */
export const LIVE_STATUSES = ['active', 'expired_grace', 'redemption'] as const

export const DOMAIN_LIST_SPEC: ListSpec<DomainSort, DomainStatus> = {
  sorts: DOMAIN_SORTS,
  defaultSort: 'expires',
  defaultDir: 'asc',
  statuses: DOMAIN_STATUSES,
  perOptions: [25, 50, 100],
}

/** The column each sort orders by; soonest expiry first by default. */
export const DOMAIN_SORT_COLUMN: Readonly<
  Record<DomainSort, 'expires_at' | 'created_at' | 'domain_name' | 'registry_checked_at'>
> = {
  expires: 'expires_at',
  added: 'created_at',
  name: 'domain_name',
  checked: 'registry_checked_at',
}

export const DOMAIN_SORT_LABEL: Readonly<Record<DomainSort, string>> = {
  expires: 'Expires',
  added: 'Added',
  name: 'Name',
  checked: 'Registry read',
}

/** `?expires=`: already past, or within so many days from now. */
export const EXPIRY_WINDOWS = ['expired', '30', '60', '90'] as const
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]

export const EXPIRY_WINDOW_LABEL: Readonly<Record<ExpiryWindow, string>> = {
  expired: 'Already expired',
  '30': 'Within 30 days',
  '60': 'Within 60 days',
  '90': 'Within 90 days',
}

/** `domains.delegation_status`: whether public DNS answers with the domain's nameservers (FR-D5). */
export const DELEGATION_STATES = ['verified', 'pending', 'failed', 'undelegated'] as const
export type DelegationState = (typeof DELEGATION_STATES)[number]

export const RENEW_CHOICES = ['on', 'off'] as const
export type RenewChoice = (typeof RENEW_CHOICES)[number]

/**
 * `domains.source`. Demo rows are left out unless asked for, as the stats
 * leave them out: they were never at a registry.
 */
export const DOMAIN_SOURCES = ['registration', 'transfer', 'demo'] as const
export type DomainSource = (typeof DOMAIN_SOURCES)[number]

/** What the search box was given. A name is matched as part of a domain, never as a pattern. */
export type DomainSearch =
  | { kind: 'none' }
  | { kind: 'name'; value: string }
  /** Refused: an email is never searched here, and never kept in a link. */
  | { kind: 'email' }
  /** Nothing a domain can be found by. */
  | { kind: 'unknown' }

/** The longest search the box sends (its `maxLength`). */
export const DOMAIN_SEARCH_MAX = 120

/** Letters, digits, dots and hyphens only: nothing LIKE or PostgREST reads as syntax. */
const NAME_PART = /^[a-z0-9.-]{2,253}$/
const TLD = /^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/

/**
 * Reads the search box: a domain, or part of one (`getpaid`, `.com.ng`), in
 * its ASCII form, lower-cased (FR-S8) — an international name is searched by
 * its `xn--` form.
 */
export function classifyDomainSearch(input: string | null | undefined): DomainSearch {
  const text = (input ?? '').trim()
  if (text === '') return { kind: 'none' }
  if (text.includes('@')) return { kind: 'email' }
  if (text.length > DOMAIN_SEARCH_MAX) return { kind: 'unknown' }
  const ascii = toAsciiHost(text.replace(/\.$/, ''))
  if (ascii && NAME_PART.test(ascii)) return { kind: 'name', value: ascii }
  return { kind: 'unknown' }
}

export type DomainListParams = ListParams<DomainSort, DomainStatus> & {
  tld: string | null
  expires: ExpiryWindow | null
  delegation: DelegationState | null
  renew: RenewChoice | null
  source: DomainSource | null
  /** The search as typed, for the box — empty when it was an email. */
  q: string
  search: DomainSearch
}

type Search = Record<string, string | string[] | undefined> | URLSearchParams

function first(search: Search, key: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | null {
  return value !== undefined && (values as readonly string[]).includes(value) ? (value as T) : null
}

/** An extension from the URL, without its dot; anything else is null. */
export function parseTld(value: string | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase().replace(/^\./, '')
  return TLD.test(text) ? text : null
}

export function parseDomainListParams(search: Search): DomainListParams {
  const base = parseListParams(search, DOMAIN_LIST_SPEC)
  const searchResult = classifyDomainSearch(first(search, 'q'))
  const q = searchResult.kind === 'email' ? '' : (first(search, 'q') ?? '').trim()
  return {
    ...base,
    tld: parseTld(first(search, 'tld')),
    expires: oneOf(EXPIRY_WINDOWS, first(search, 'expires')),
    delegation: oneOf(DELEGATION_STATES, first(search, 'delegation')),
    renew: oneOf(RENEW_CHOICES, first(search, 'renew')),
    source: oneOf(DOMAIN_SOURCES, first(search, 'source')),
    q: q.slice(0, DOMAIN_SEARCH_MAX),
    search: searchResult,
  }
}

/** True when the list is narrowed by anything but its sort and page. */
export function isFiltered(params: DomainListParams): boolean {
  return (
    params.status.length > 0 ||
    params.from !== null ||
    params.to !== null ||
    params.tld !== null ||
    params.expires !== null ||
    params.delegation !== null ||
    params.renew !== null ||
    params.source !== null ||
    params.search.kind !== 'none'
  )
}

export type DomainChanges = Partial<ListParams<DomainSort, DomainStatus>> & {
  tld?: string | null
  expires?: ExpiryWindow | null
  delegation?: DelegationState | null
  renew?: RenewChoice | null
  source?: DomainSource | null
  q?: string
}

/**
 * A link to the list with some values changed, keeping the rest. An email is
 * never carried into a link (`q` is empty for one), and changing a filter
 * goes back to page 1.
 */
export function domainsHref(params: DomainListParams, changes: DomainChanges = {}): string {
  const { tld, expires, delegation, renew, source, q, ...rest } = changes
  const extrasChanged = [tld, expires, delegation, renew, source, q].some(
    (value) => value !== undefined,
  )
  const listChanges = extrasChanged && rest.page === undefined ? { ...rest, page: 1 } : rest
  const pick = <T>(change: T | undefined, current: T) => (change === undefined ? current : change)
  const nextQ = pick(q, params.q)
  return listHref('/admin/domains', params, DOMAIN_LIST_SPEC, {
    ...listChanges,
    extra: {
      tld: pick(tld, params.tld),
      expires: pick(expires, params.expires),
      delegation: pick(delegation, params.delegation),
      renew: pick(renew, params.renew),
      source: pick(source, params.source),
      q: nextQ === '' ? null : nextQ,
    },
  })
}

/** The unfiltered list, for building links from nothing (the stats tiles). */
export const NO_FILTERS: DomainListParams = parseDomainListParams({})

/** A link to the list showing only these filters, from the default list. */
export function filteredHref(changes: DomainChanges): string {
  return domainsHref(NO_FILTERS, changes)
}

/** Toggling one status chip. */
export function toggleStatus(params: DomainListParams, status: DomainStatus): DomainStatus[] {
  return params.status.includes(status)
    ? params.status.filter((value) => value !== status)
    : [...params.status, status]
}

const DAY_MS = 86_400_000

/**
 * The instants an expiry window covers, as `admin_domain_stats` counts it:
 * `expired` is before now; a number of days is from now to that many days on.
 */
export function expiryRange(
  window: ExpiryWindow,
  now: Date,
): { before?: string; from?: string; to?: string } {
  if (window === 'expired') return { before: now.toISOString() }
  return {
    from: now.toISOString(),
    to: new Date(now.getTime() + Number(window) * DAY_MS).toISOString(),
  }
}

/** The instant a WAT day starts: Lagos is UTC+1 all year, with no daylight saving. */
export function watDayStart(day: string): string {
  return `${day}T00:00:00+01:00`
}

/** The instant after a WAT day ends — an exclusive upper bound. */
export function watDayEnd(day: string): string {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
  return watDayStart(next)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A domain id from the route, lower-cased; anything else is null. */
export function parseDomainId(value: string | string[] | undefined | null): string | null {
  const text = Array.isArray(value) ? value[0] : value
  return text && UUID.test(text) ? text.toLowerCase() : null
}
