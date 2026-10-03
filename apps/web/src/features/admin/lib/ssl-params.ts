import { SSL_STATUSES, type SslStatus } from '@dr/shared'
import {
  type ListParams,
  type ListSpec,
  listHref,
  parseListParams,
} from '@/features/admin/lib/list-params'
import { toAsciiHost } from '@/features/search/lib/idn'

/**
 * The certificates list's URL (docs/ADMIN-SPEC.md §5.2, B10): the shared
 * `?status=&from=&to=&sort=&dir=&page=&per=`, plus `unrecognised=1`,
 * `line=<order_item_id>` and the search box's `q`. Everything is parsed
 * strictly: an unknown value falls back to the default rather than reaching
 * a query. Other pages link here by id (`/admin/ssl/<id>`) or with these.
 *
 * `q` takes a certificate's name — `example.com` or `*.example.com` — and
 * nothing else. Never an email: one in a URL stays in history and logs (N13).
 */

export const SSL_SORTS = ['ordered', 'expires', 'checked'] as const
export type SslSort = (typeof SSL_SORTS)[number]

export type { SslStatus }
export { SSL_STATUSES }

export const SSL_LIST_SPEC: ListSpec<SslSort, SslStatus> = {
  sorts: SSL_SORTS,
  defaultSort: 'ordered',
  defaultDir: 'desc',
  statuses: SSL_STATUSES,
}

/** The column each sort orders by; `ordered` is the default, newest first. */
export const SSL_SORT_COLUMN: Record<SslSort, 'created_at' | 'expires_at' | 'last_checked_at'> = {
  ordered: 'created_at',
  expires: 'expires_at',
  checked: 'last_checked_at',
}

export const SSL_SORT_LABEL: Record<SslSort, string> = {
  ordered: 'Ordered',
  expires: 'Expires',
  checked: 'Last checked',
}

/** The longest search the box sends (its `maxLength`). */
export const SSL_SEARCH_MAX = 120

/** What the search box was given. A name is looked up exactly, never as a pattern. */
export type SslSearch =
  | { kind: 'none' }
  /** `names`: the name as typed and, for a bare name, its wildcard too. */
  | { kind: 'name'; value: string; names: string[] }
  /** Refused: an email is never searched here, and never kept in a link. */
  | { kind: 'email' }
  /** Nothing a certificate can be found by. */
  | { kind: 'unknown' }

const HOST =
  /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Reads the search box: a certificate's name, in its ASCII form (FR-S8). A
 * bare name finds the certificate for it and the wildcard over it, as the
 * supplier knows each by its own name (`example.com`, `*.example.com`).
 */
export function classifySslSearch(input: string | null | undefined): SslSearch {
  const text = (input ?? '').trim()
  if (text === '') return { kind: 'none' }
  if (text.includes('@')) return { kind: 'email' }
  if (text.length > SSL_SEARCH_MAX) return { kind: 'unknown' }
  const wildcard = text.startsWith('*.')
  const host = toAsciiHost(text.replace(/^\*\./, '').replace(/\.$/, ''))
  if (!host || !HOST.test(host)) return { kind: 'unknown' }
  return wildcard
    ? { kind: 'name', value: `*.${host}`, names: [`*.${host}`] }
    : { kind: 'name', value: host, names: [host, `*.${host}`] }
}

export type SslListParams = ListParams<SslSort, SslStatus> & {
  /** Only certificates whose last supplier word is not one we know. */
  unrecognised: boolean
  /** One order line's certificate (an order page links here by its line). */
  line: string | null
  /** The search as typed, for the box — empty when it was an email. */
  q: string
  search: SslSearch
}

type Search = Record<string, string | string[] | undefined> | URLSearchParams

function first(search: Search, key: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

export function parseSslListParams(search: Search): SslListParams {
  const base = parseListParams(search, SSL_LIST_SPEC)
  const lineText = first(search, 'line')
  const searchResult = classifySslSearch(first(search, 'q'))
  const q = searchResult.kind === 'email' ? '' : (first(search, 'q') ?? '').trim()
  return {
    ...base,
    unrecognised: first(search, 'unrecognised') === '1',
    line: lineText && UUID.test(lineText) ? lineText.toLowerCase() : null,
    q: q.slice(0, SSL_SEARCH_MAX),
    search: searchResult,
  }
}

/** True when the list is narrowed by anything but its sort and page. */
export function isSslFiltered(params: SslListParams): boolean {
  return (
    params.status.length > 0 ||
    params.from !== null ||
    params.to !== null ||
    params.unrecognised ||
    params.line !== null ||
    params.search.kind !== 'none'
  )
}

type SslChanges = Partial<ListParams<SslSort, SslStatus>> & {
  unrecognised?: boolean
  line?: string | null
  q?: string
}

/**
 * A link to the list with some values changed, keeping the rest. An email
 * is never carried into a link (`q` is empty for one), and changing a filter
 * goes back to page 1.
 */
export function sslHref(params: SslListParams, changes: SslChanges = {}): string {
  const { unrecognised, line, q, ...rest } = changes
  const extrasChanged = unrecognised !== undefined || line !== undefined || q !== undefined
  const listChanges = extrasChanged && rest.page === undefined ? { ...rest, page: 1 } : rest
  const nextQ = q ?? params.q
  return listHref('/admin/ssl', params, SSL_LIST_SPEC, {
    ...listChanges,
    extra: {
      unrecognised: (unrecognised ?? params.unrecognised) ? '1' : null,
      line: line === undefined ? params.line : line,
      q: nextQ === '' ? null : nextQ,
    },
  })
}

/** Toggling one status chip. */
export function toggleSslStatus(params: SslListParams, status: SslStatus): SslStatus[] {
  return params.status.includes(status)
    ? params.status.filter((value) => value !== status)
    : [...params.status, status]
}

/** Lagos midnight at the start of a `YYYY-MM-DD` day (WAT is UTC+1, with no daylight saving). */
export function watDayStart(day: string): string {
  return `${day}T00:00:00+01:00`
}

/** Lagos midnight at the end of a `YYYY-MM-DD` day: the next day's start. */
export function watDayEnd(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return watDayStart(date.toISOString().slice(0, 10))
}

/** A certificate id from a route param, or null: nothing else is ever read. */
export function parseCertificateId(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null
}
