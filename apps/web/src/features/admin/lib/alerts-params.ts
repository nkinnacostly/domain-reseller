import {
  type ListParams,
  type ListSpec,
  listHref,
  nextSort,
  parseListParams,
} from '@/features/admin/lib/list-params'

/**
 * The alerts page's URL (docs/ADMIN-SPEC.md §5.2, B5): `?tab=open|history|
 * drift|health`, then each list's own `sort`, `dir`, `page`, `per`, and on
 * History the state chips, a `kind` and a date range. Parsing is strict — an
 * unknown tab is Open, an unknown kind is dropped — and links are rebuilt
 * from the parsed values. The tab names are the ones `adminHrefForAlertKey`
 * links to (`?tab=drift`, `?tab=health`).
 */

export const ALERTS_PATH = '/admin/alerts'

export const ALERT_TABS = ['open', 'history', 'drift', 'health'] as const
export type AlertTab = (typeof ALERT_TABS)[number]

export type OpenSort = 'severity' | 'first_seen' | 'last_seen'
export type HistorySort = 'last_seen' | 'first_seen' | 'notified'
export type HistoryState = 'open' | 'resolved'
export type DriftSort = 'last_seen' | 'first_seen'

/** Critical first (`severity` ascending), then the most recently seen. */
export const OPEN_SPEC: ListSpec<OpenSort> = {
  sorts: ['severity', 'first_seen', 'last_seen'],
  defaultSort: 'severity',
  defaultDir: 'asc',
  perOptions: [50, 100],
}

export const HISTORY_SPEC: ListSpec<HistorySort, HistoryState> = {
  sorts: ['last_seen', 'first_seen', 'notified'],
  defaultSort: 'last_seen',
  defaultDir: 'desc',
  statuses: ['open', 'resolved'],
  perOptions: [25, 50, 100],
}

export const DRIFT_SPEC: ListSpec<DriftSort> = {
  sorts: ['last_seen', 'first_seen'],
  defaultSort: 'last_seen',
  defaultDir: 'desc',
  perOptions: [25, 50, 100],
}

export type AlertsParams =
  | { tab: 'open'; list: ListParams<OpenSort> }
  | { tab: 'history'; list: ListParams<HistorySort, HistoryState>; kind: string | null }
  | { tab: 'drift'; list: ListParams<DriftSort> }
  | { tab: 'health' }

type Search = Record<string, string | string[] | undefined> | URLSearchParams

/** An alert kind as SQL writes them: `refund_held`, `drift_unknown_domain`. */
const KIND = /^[a-z][a-z0-9_]{0,59}$/

function first(search: Search, key: string): string | undefined {
  if (search instanceof URLSearchParams) return search.get(key) ?? undefined
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

export function parseAlertTab(value: string | undefined): AlertTab {
  return (ALERT_TABS as readonly string[]).includes(value ?? '') ? (value as AlertTab) : 'open'
}

/** A kind to filter History by, or null for anything that is not one. */
export function parseAlertKind(value: string | undefined): string | null {
  return value && KIND.test(value) ? value : null
}

export function parseAlertsParams(search: Search): AlertsParams {
  const tab = parseAlertTab(first(search, 'tab'))
  switch (tab) {
    case 'open':
      return { tab, list: parseListParams(search, OPEN_SPEC) }
    case 'history':
      return {
        tab,
        list: parseListParams(search, HISTORY_SPEC),
        kind: parseAlertKind(first(search, 'kind')),
      }
    case 'drift':
      return { tab, list: parseListParams(search, DRIFT_SPEC) }
    case 'health':
      return { tab }
  }
}

/** A tab's own address: Open is the page itself; the others say `?tab=`. */
export function alertsTabHref(tab: AlertTab): string {
  return tab === 'open' ? ALERTS_PATH : `${ALERTS_PATH}?tab=${tab}`
}

type ListChanges<S extends string, T extends string> = Partial<ListParams<S, T>> & {
  kind?: string | null
}

/**
 * The same list with some values changed (a page, a sort, a chip). The tab
 * comes last so a list's own query reads first; History keeps its kind.
 */
export function alertsListHref(
  params: Exclude<AlertsParams, { tab: 'health' }>,
  changes: ListChanges<string, string> = {},
): string {
  const { kind: kindChange, ...rest } = changes
  const tab = params.tab === 'open' ? null : params.tab
  switch (params.tab) {
    case 'open':
      return listHref(ALERTS_PATH, params.list, OPEN_SPEC, {
        ...(rest as Partial<ListParams<OpenSort>>),
        extra: { tab },
      })
    case 'history': {
      const kind = kindChange === undefined ? params.kind : kindChange
      const extra = { kind, tab }
      // A kind that changes is a filter that changes: back to page 1.
      const page = kindChange !== undefined && rest.page === undefined ? { page: 1 } : {}
      return listHref(ALERTS_PATH, params.list, HISTORY_SPEC, {
        ...(rest as Partial<ListParams<HistorySort, HistoryState>>),
        ...page,
        extra,
      })
    }
    case 'drift':
      return listHref(ALERTS_PATH, params.list, DRIFT_SPEC, {
        ...(rest as Partial<ListParams<DriftSort>>),
        extra: { tab },
      })
  }
}

/** The link a sortable header points at: the same column flips, another starts descending. */
export function alertsSortHref(
  params: Exclude<AlertsParams, { tab: 'health' }>,
  column: string,
): string {
  const { sort, dir } = nextSort(params.list as { sort: string; dir: 'asc' | 'desc' }, column)
  return alertsListHref(params, { sort, dir })
}

/** The state chips toggle one at a time: choosing the chosen one clears it. */
export function historyStateHref(
  params: Extract<AlertsParams, { tab: 'history' }>,
  state: HistoryState,
): string {
  const status: HistoryState[] = params.list.status.includes(state) ? [] : [state]
  return alertsListHref(params, { status })
}

/** A kind chip: choosing the chosen kind clears it. */
export function historyKindHref(
  params: Extract<AlertsParams, { tab: 'history' }>,
  kind: string,
): string {
  return alertsListHref(params, { kind: params.kind === kind ? null : kind })
}

/**
 * History's date range as times: alerts seen at any point in it — last seen
 * on or after the first day, first seen before the day after the last. Days
 * are Lagos days (WAT, UTC+1, no daylight saving).
 */
export function historyWindow(list: { from: string | null; to: string | null }): {
  seenSince: string | null
  seenBefore: string | null
} {
  return {
    seenSince: list.from ? `${list.from}T00:00:00+01:00` : null,
    seenBefore: list.to ? `${nextDay(list.to)}T00:00:00+01:00` : null,
  }
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}
