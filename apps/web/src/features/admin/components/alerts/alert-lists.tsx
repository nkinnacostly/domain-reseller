import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { FOCUS } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { StatTile } from '@/features/admin/components/stat-tile'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import {
  alertKindLabel,
  destinationLabel,
  notifiedLabel,
  OPEN_NOTE,
} from '@/features/admin/lib/alerts-copy'
import {
  ALERT_SEVERITIES,
  ALERTS_PATH,
  type AlertSeverity,
  type AlertsParams,
  alertsListHref,
  alertsSortHref,
  type HistorySort,
  historyKindHref,
  historyStateHref,
  type OpenSort,
  openSeverityHref,
} from '@/features/admin/lib/alerts-params'
import { formatCount } from '@/features/admin/lib/format'
import { labelFor, SEVERITY_LABEL } from '@/features/admin/lib/labels'
import { pageCount } from '@/features/admin/lib/list-params'
import {
  type AlertRow,
  type AlertStats,
  getAlertStats,
  listAlertHistory,
  listOpenAlerts,
  type Read,
} from '@/features/admin/queries/alerts'
import type { AdminPrincipal, AdminSide } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { AlertsNote, AlertsSection, PastTheLastPage, SeenAt, SeverityPill } from './alert-parts'

/**
 * Open alerts and their history (ADMIN-SPEC §5.2, B5). Read-only: an alert
 * closes when its condition goes, so there is no dismiss, and each row links
 * to where its cause is worked (`adminHrefForAlertKey`).
 */

type OpenParams = Extract<AlertsParams, { tab: 'open' }>
type HistoryParams = Extract<AlertsParams, { tab: 'history' }>

/** The alert's kind in words, with its summary under it. */
function AlertCell({ row }: { row: AlertRow }) {
  return (
    <span className="block min-w-0">
      <span className="block">{alertKindLabel(row.kind)}</span>
      <span className="mt-1 block text-sm font-normal break-words text-muted-foreground">
        {row.summary}
      </span>
    </span>
  )
}

/** Where the alert is worked. The name says where it goes and which alert it is. */
export function AlertLink({ row }: { row: AlertRow }) {
  return (
    <Link
      href={row.href}
      data-alert-id={row.id}
      className={cn(
        'inline-flex min-h-11 items-center rounded font-medium text-brand-ink underline underline-offset-4 hover:no-underline active:opacity-80',
        FOCUS,
      )}
    >
      {destinationLabel(row.href)}
      <span className="sr-only">, for the alert “{alertKindLabel(row.kind)}”</span>
    </Link>
  )
}

function openColumns(now: Date): Column<AlertRow, OpenSort>[] {
  return [
    { key: 'alert', header: 'Alert', cell: (row) => <AlertCell row={row} /> },
    {
      key: 'severity',
      header: 'Severity',
      sort: 'severity',
      cell: (row) => <SeverityPill severity={row.severity} />,
    },
    {
      key: 'first',
      header: 'First seen',
      sort: 'first_seen',
      cell: (row) => <SeenAt at={row.firstSeenAt} now={now} />,
    },
    {
      key: 'last',
      header: 'Last seen',
      sort: 'last_seen',
      cell: (row) => <SeenAt at={row.lastSeenAt} now={now} />,
    },
    { key: 'where', header: 'Where to look', cell: (row) => <AlertLink row={row} /> },
  ]
}

export async function OpenAlerts({
  admin,
  side,
  params,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: OpenParams
  now: Date
}) {
  const result = await listOpenAlerts(admin, side, params.list, params.severity)
  return (
    <AlertsSection
      id="open-alerts-heading"
      title="Open alerts"
      aside={
        result.ok ? (
          <p className="text-sm text-muted-foreground">{formatCount(result.data.total)} open</p>
        ) : null
      }
    >
      <AlertsNote testId="alerts-no-dismiss">{OPEN_NOTE}</AlertsNote>
      <FilterChips
        label="Severity"
        chips={ALERT_SEVERITIES.map((value) => ({ value, label: labelFor(SEVERITY_LABEL, value) }))}
        selected={params.severity ? [params.severity] : []}
        href={(value) => openSeverityHref(params, value as AlertSeverity)}
        allHref={alertsListHref(params, { severity: null })}
      />
      {result.ok ? (
        <>
          <DataTable
            caption={
              params.severity
                ? `Open alerts, ${labelFor(SEVERITY_LABEL, params.severity).toLowerCase()} only`
                : 'Open alerts, critical first'
            }
            rows={result.data.rows}
            rowKey={(row) => String(row.id)}
            columns={openColumns(now)}
            sorting={{
              sort: params.list.sort,
              dir: params.list.dir,
              href: (sort) => alertsSortHref(params, sort),
            }}
            empty={
              result.data.total > 0 ? (
                <PastTheLastPage firstPage={alertsListHref(params, { page: 1 })} />
              ) : params.severity ? (
                <EmptyState
                  title={`No open ${labelFor(SEVERITY_LABEL, params.severity).toLowerCase()} alerts`}
                  body="Nothing of this severity is open on this side right now."
                  action={
                    <Link
                      href={alertsListHref(params, { severity: null })}
                      className={QUIET_BUTTON}
                    >
                      Show every open alert
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  title="No open alerts"
                  body="Nothing on this side needs a person right now. Closed alerts are under History."
                  action={
                    <Link href={`${ALERTS_PATH}?tab=history`} className={QUIET_BUTTON}>
                      See the history
                    </Link>
                  }
                />
              )
            }
          />
          {result.data.total > 0 ? (
            <Pager
              page={params.list.page}
              pageCount={pageCount(result.data.total, params.list.per)}
              total={result.data.total}
              href={(page) => alertsListHref(params, { page })}
            />
          ) : null}
        </>
      ) : (
        <ErrorState title="The open alerts couldn't be loaded." />
      )}
    </AlertsSection>
  )
}

const STATE_LABEL = { open: 'Open', resolved: 'Closed' }

function historyColumns(now: Date): Column<AlertRow, HistorySort>[] {
  return [
    { key: 'alert', header: 'Alert', cell: (row) => <AlertCell row={row} /> },
    {
      key: 'severity',
      header: 'Severity',
      cell: (row) => <SeverityPill severity={row.severity} />,
    },
    {
      key: 'first',
      header: 'First seen',
      sort: 'first_seen',
      cell: (row) => <SeenAt at={row.firstSeenAt} now={now} />,
    },
    {
      key: 'last',
      header: 'Last seen',
      sort: 'last_seen',
      cell: (row) => <SeenAt at={row.lastSeenAt} now={now} />,
    },
    {
      key: 'notified',
      header: 'Telegram',
      sort: 'notified',
      numeric: true,
      cell: (row) => notifiedLabel(row.notifyCount),
    },
    {
      key: 'state',
      header: 'State',
      cell: (row) =>
        row.resolvedAt === null ? (
          <AdminStatusPill value="open" labels={STATE_LABEL} tone="warning" />
        ) : (
          <span className="inline-flex flex-col items-end gap-1 sm:items-start">
            <AdminStatusPill value="resolved" labels={STATE_LABEL} tone="ok" />
            <SeenAt at={row.resolvedAt} now={now} />
          </span>
        ),
    },
    { key: 'where', header: 'Where to look', cell: (row) => <AlertLink row={row} /> },
  ]
}

/** One chip per kind seen in the stats' window, with how many there were. */
function kindChips(stats: AlertStats | null): { value: string; label: string; count: number }[] {
  const totals = new Map<string, number>()
  for (const entry of stats?.byKind ?? []) {
    totals.set(entry.kind, (totals.get(entry.kind) ?? 0) + entry.open + entry.resolved)
  }
  return [...totals]
    .sort(([a], [b]) => alertKindLabel(a).localeCompare(alertKindLabel(b)))
    .map(([kind, count]) => ({ value: kind, label: alertKindLabel(kind), count }))
}

/** The window's figures, from `admin_alert_stats`. */
function HistoryStats({ stats, days }: { stats: Read<AlertStats>; days: number }) {
  if (!stats.ok) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        The counts by kind couldn't be loaded; the list below is unaffected.
      </p>
    )
  }
  const open = stats.data.byKind.reduce((sum, entry) => sum + entry.open, 0)
  const critical = stats.data.byKind
    .filter((entry) => entry.severity === 'critical')
    .reduce((sum, entry) => sum + entry.open, 0)
  const closed = stats.data.byKind.reduce((sum, entry) => sum + entry.resolved, 0)
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile
        label="Open now"
        value={formatCount(open)}
        tone={open > 0 ? 'warning' : 'neutral'}
      />
      <StatTile
        label="Critical and open"
        value={formatCount(critical)}
        tone={critical > 0 ? 'danger' : 'neutral'}
      />
      <StatTile label={`Raised and closed, last ${days} days`} value={formatCount(closed)} />
    </div>
  )
}

/** History's dates: a GET form, so the URL holds them like every other filter. */
function DateRange({ params }: { params: HistoryParams }) {
  const { list } = params
  const keep: Record<string, string | null> = {
    tab: 'history',
    status: list.status.length > 0 ? list.status.join(',') : null,
    kind: params.kind,
    sort: list.sort === 'last_seen' ? null : list.sort,
    dir: list.dir === 'desc' ? null : list.dir,
  }
  const input =
    'h-11 w-full rounded-xl border border-input bg-background px-3 text-base text-foreground sm:w-44 sm:text-sm'
  return (
    <form
      action={ALERTS_PATH}
      method="get"
      aria-label="Seen between"
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
    >
      {Object.entries(keep).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      <label className="grid gap-1 text-sm text-muted-foreground">
        Seen on or after
        <input
          type="date"
          name="from"
          defaultValue={list.from ?? ''}
          className={cn(input, FOCUS)}
        />
      </label>
      <label className="grid gap-1 text-sm text-muted-foreground">
        Seen on or before
        <input type="date" name="to" defaultValue={list.to ?? ''} className={cn(input, FOCUS)} />
      </label>
      <button type="submit" className={QUIET_BUTTON}>
        Show these dates
      </button>
      {list.from || list.to ? (
        <Link href={alertsListHref(params, { from: null, to: null })} className={QUIET_BUTTON}>
          Clear the dates
        </Link>
      ) : null}
    </form>
  )
}

export const HISTORY_STATS_DAYS = 30

export async function AlertHistory({
  admin,
  side,
  params,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: HistoryParams
  now: Date
}) {
  const [result, stats] = await Promise.all([
    listAlertHistory(admin, side, params.list, params.kind),
    getAlertStats(side, HISTORY_STATS_DAYS),
  ])
  const chips = kindChips(stats.ok ? stats.data : null)
  // A kind chosen from a link but not in the window still shows as chosen.
  if (params.kind && !chips.some((chip) => chip.value === params.kind)) {
    chips.unshift({ value: params.kind, label: alertKindLabel(params.kind), count: 0 })
  }
  const filtered =
    params.list.status.length > 0 || params.kind !== null || params.list.from || params.list.to
  return (
    <AlertsSection
      id="alert-history-heading"
      title="Alert history"
      aside={
        result.ok ? (
          <p className="text-sm text-muted-foreground">
            {formatCount(result.data.total)} {filtered ? 'match' : 'in all'}
          </p>
        ) : null
      }
    >
      <AlertsNote>
        Every alert on this side, open or closed; closed alerts are kept for 90 days. {OPEN_NOTE}
      </AlertsNote>
      <HistoryStats stats={stats} days={HISTORY_STATS_DAYS} />
      <div className="space-y-3">
        <FilterChips
          label="Alert state"
          chips={[
            { value: 'open', label: 'Open' },
            { value: 'resolved', label: 'Closed' },
          ]}
          selected={params.list.status}
          href={(value) => historyStateHref(params, value as 'open' | 'resolved')}
          allHref={alertsListHref(params, { status: [] })}
        />
        {chips.length > 0 ? (
          <FilterChips
            label="Alert kind"
            chips={chips}
            selected={params.kind ? [params.kind] : []}
            href={(value) => historyKindHref(params, value)}
            allHref={alertsListHref(params, { kind: null })}
          />
        ) : null}
        <DateRange params={params} />
      </div>
      {result.ok ? (
        <>
          <DataTable
            caption="Alert history"
            rows={result.data.rows}
            rowKey={(row) => String(row.id)}
            columns={historyColumns(now)}
            sorting={{
              sort: params.list.sort,
              dir: params.list.dir,
              href: (sort) => alertsSortHref(params, sort),
            }}
            empty={
              result.data.total > 0 ? (
                <PastTheLastPage firstPage={alertsListHref(params, { page: 1 })} />
              ) : (
                <EmptyState
                  title={filtered ? 'No alerts match these filters' : 'No alerts on this side yet'}
                  body={
                    filtered
                      ? 'Clear a filter or choose other dates.'
                      : 'Alerts appear here when a condition needs a person, and stay for 90 days after they close.'
                  }
                  action={
                    filtered ? (
                      <Link href={`${ALERTS_PATH}?tab=history`} className={QUIET_BUTTON}>
                        Clear the filters
                      </Link>
                    ) : undefined
                  }
                />
              )
            }
          />
          {result.data.total > 0 ? (
            <Pager
              page={params.list.page}
              pageCount={pageCount(result.data.total, params.list.per)}
              total={result.data.total}
              href={(page) => alertsListHref(params, { page })}
            />
          ) : null}
        </>
      ) : (
        <ErrorState title="The alert history couldn't be loaded." />
      )}
    </AlertsSection>
  )
}
