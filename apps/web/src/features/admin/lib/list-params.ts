/**
 * Every admin list is driven by its URL (docs/ADMIN-SPEC.md §5.2):
 * `?status=&from=&to=&sort=&dir=&page=&per=`. Parsing is strict — an unknown
 * sort, status or page size falls back to the default rather than reaching a
 * query — and links are built from the parsed values, never by appending to
 * the raw query string.
 */

export type SortDir = 'asc' | 'desc'

export type ListSpec<S extends string, T extends string = string> = {
  sorts: readonly S[]
  defaultSort: S
  defaultDir?: SortDir
  /** The status chips this list knows; anything else in `?status=` is dropped. */
  statuses?: readonly T[]
  perOptions?: readonly number[]
  defaultPer?: number
}

export type ListParams<S extends string, T extends string = string> = {
  sort: S
  dir: SortDir
  page: number
  per: number
  status: T[]
  from: string | null
  to: string | null
}

type Search = Record<string, string | string[] | undefined> | URLSearchParams

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_PAGE = 10_000

function all(search: Search, key: string): string[] {
  if (search instanceof URLSearchParams) return search.getAll(key)
  const value = search[key]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function first(search: Search, key: string): string | undefined {
  return all(search, key)[0]
}

/** A real calendar date, `YYYY-MM-DD`; anything else is null. */
export function validDate(value: string | undefined): string | null {
  if (!value || !DATE.test(value)) return null
  const time = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(time)) return null
  return new Date(time).toISOString().slice(0, 10) === value ? value : null
}

export function parseListParams<S extends string, T extends string = string>(
  search: Search,
  spec: ListSpec<S, T>,
): ListParams<S, T> {
  const perOptions = spec.perOptions ?? [25, 50, 100]
  const defaultPer = spec.defaultPer ?? perOptions[0] ?? 25
  const sortText = first(search, 'sort')
  const sort = (spec.sorts as readonly string[]).includes(sortText ?? '')
    ? (sortText as S)
    : spec.defaultSort
  const dirText = first(search, 'dir')
  const dir: SortDir =
    dirText === 'asc' || dirText === 'desc' ? dirText : (spec.defaultDir ?? 'desc')
  const pageText = first(search, 'page') ?? '1'
  const page = /^\d{1,5}$/.test(pageText) ? Math.min(Math.max(Number(pageText), 1), MAX_PAGE) : 1
  const perText = Number(first(search, 'per'))
  const per = perOptions.includes(perText) ? perText : defaultPer
  const known = new Set<string>(spec.statuses ?? [])
  const status = [
    ...new Set(
      all(search, 'status')
        .flatMap((value) => value.split(','))
        .filter((value) => known.has(value)),
    ),
  ] as T[]
  let from = validDate(first(search, 'from'))
  let to = validDate(first(search, 'to'))
  if (from && to && from > to) [from, to] = [to, from]
  return { sort, dir, page, per, status, from, to }
}

/** The rows a page covers, for `.range(from, to)` (inclusive). */
export function pageRange(params: { page: number; per: number }): { from: number; to: number } {
  const from = (params.page - 1) * params.per
  return { from, to: from + params.per - 1 }
}

export function pageCount(total: number, per: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / per))
}

/**
 * A link to the same list with some values changed. Defaults are left out of
 * the URL; changing a filter or sort goes back to page 1.
 */
export function listHref<S extends string, T extends string>(
  base: string,
  params: ListParams<S, T>,
  spec: ListSpec<S, T>,
  changes: Partial<ListParams<S, T>> & { extra?: Record<string, string | null> } = {},
): string {
  const { extra, ...rest } = changes
  const filtersChanged = ['sort', 'dir', 'status', 'from', 'to', 'per'].some((key) => key in rest)
  const next = { ...params, ...rest, page: rest.page ?? (filtersChanged ? 1 : params.page) }
  const query = new URLSearchParams()
  if (next.status.length > 0) query.set('status', next.status.join(','))
  if (next.from) query.set('from', next.from)
  if (next.to) query.set('to', next.to)
  if (next.sort !== spec.defaultSort) query.set('sort', next.sort)
  if (next.dir !== (spec.defaultDir ?? 'desc')) query.set('dir', next.dir)
  const defaultPer = spec.defaultPer ?? spec.perOptions?.[0] ?? 25
  if (next.per !== defaultPer) query.set('per', String(next.per))
  if (next.page > 1) query.set('page', String(next.page))
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== null && value !== '') query.set(key, value)
  }
  const text = query.toString()
  return text ? `${base}?${text}` : base
}

/** The `aria-sort` value for a column header. */
export function ariaSort<S extends string>(
  params: { sort: S; dir: SortDir },
  column: S,
): 'ascending' | 'descending' | 'none' {
  if (params.sort !== column) return 'none'
  return params.dir === 'asc' ? 'ascending' : 'descending'
}

/** Toggling a sort: the same column flips direction; another starts descending. */
export function nextSort<S extends string>(
  params: { sort: S; dir: SortDir },
  column: S,
): { sort: S; dir: SortDir } {
  if (params.sort === column) return { sort: column, dir: params.dir === 'asc' ? 'desc' : 'asc' }
  return { sort: column, dir: 'desc' }
}
