import Link from 'next/link'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { StatTile } from '@/features/admin/components/stat-tile'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import { TableToolbar } from '@/features/admin/components/table/table-toolbar'
import { ago, formatCount, formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { labelFor, REFUND_REASON_LABEL, REFUND_STATUS_LABEL } from '@/features/admin/lib/labels'
import {
  type ListParams,
  listHref,
  nextSort,
  pageCount,
  parseListParams,
} from '@/features/admin/lib/list-params'
import { naira } from '@/features/admin/lib/refunds-copy'
import {
  orderNumberQuery,
  parseReasons,
  queryText,
  REFUND_LIST,
  REFUND_NEEDS_PERSON,
  REFUND_REASONS,
  REFUND_STATUSES,
  type RefundReason,
  type RefundSort,
  type RefundStatus,
  toggled,
} from '@/features/admin/lib/refunds-rules'
import {
  countOpenIncidents,
  getRefundStats,
  listRefunds,
  type RefundRow,
  type RefundStats,
} from '@/features/admin/queries/refunds'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { QUIET_LINK, RefundsTabs } from './parts'

/**
 * /admin/refunds (ADMIN-SPEC §5.2 B3): what the refund worker is doing and
 * what waits for a person, on one side. The figures and the automatic
 * limits come from `admin_refund_stats`; the rows through adminDb. Every
 * filter is in the URL, and `?q=` takes an order number only.
 */

type Search = Record<string, string | string[] | undefined>

const BASE = '/admin/refunds'

/** How many refunds sit in each status, and each reason, on this side. */
function tally(stats: RefundStats | null) {
  const byStatus = new Map<string, number>()
  const byReason = new Map<string, number>()
  for (const row of stats?.byReasonStatus ?? []) {
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + row.count)
    byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + row.count)
  }
  return { byStatus, byReason }
}

export function needPersonCount(stats: RefundStats | null): number | null {
  if (!stats) return null
  const { byStatus } = tally(stats)
  return REFUND_NEEDS_PERSON.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0)
}

export async function RefundsView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const search = await searchParams
  const params = parseListParams(search, REFUND_LIST)
  const reasons = parseReasons(search)
  const q = queryText(search)
  const orderNumber = orderNumberQuery(q)
  const badQuery = q !== '' && orderNumber === null

  const [stats, list, openIncidents] = await Promise.all([
    getRefundStats(side),
    badQuery
      ? Promise.resolve({ ok: true as const, rows: [] as RefundRow[], total: 0 })
      : listRefunds(admin, side, { ...params, reasons, orderNumber }),
    countOpenIncidents(admin, side),
  ])
  const now = new Date()
  const { byStatus, byReason } = tally(stats)
  const needPerson = needPersonCount(stats)

  /** A link to this list with some values changed; filters keep each other. */
  const href = (
    changes: Partial<ListParams<RefundSort, RefundStatus>> & { reasons?: RefundReason[] } = {},
  ) => {
    const { reasons: nextReasons = reasons, ...rest } = changes
    return listHref(BASE, params, REFUND_LIST, {
      ...rest,
      ...(changes.reasons ? { page: 1 } : {}),
      extra: { reason: nextReasons.join(',') || null, q: q || null },
    })
  }
  const filtered =
    params.status.length > 0 || reasons.length > 0 || params.from || params.to || q !== ''

  const columns: Column<RefundRow, RefundSort>[] = [
    {
      key: 'refund',
      header: 'Refund',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link
            href={adminHref.refund(row.id)}
            className={cn('rounded underline-offset-4 hover:underline', FOCUS)}
          >
            Refund for {row.orderNumber ?? 'an order'}
          </Link>
          {row.testMode ? <TestBadge /> : null}
        </span>
      ),
    },
    { key: 'created', header: 'Created', sort: 'created', cell: (row) => formatWat(row.createdAt) },
    {
      key: 'reason',
      header: 'Reason',
      cell: (row) => labelFor(REFUND_REASON_LABEL, row.reason),
    },
    {
      key: 'amount',
      header: 'Amount',
      sort: 'amount',
      numeric: true,
      cell: (row) => naira(row.amountKobo),
    },
    {
      key: 'status',
      header: 'Status',
      sort: 'status',
      cell: (row) => <AdminStatusPill value={row.status} labels={REFUND_STATUS_LABEL} />,
    },
    {
      key: 'code',
      header: 'Code',
      cell: (row) =>
        row.lastErrorCode ? <code className="font-mono text-xs">{row.lastErrorCode}</code> : '—',
    },
    {
      key: 'updated',
      header: 'Last change',
      sort: 'updated',
      cell: (row) => <time dateTime={row.updatedAt}>{ago(row.updatedAt, now)}</time>,
    },
  ]

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Refunds' }]}
        title="Refunds"
        description="What the refund worker is sending, and what waits for a person. Each refund's buttons follow the playbook for its code (DEPLOY §6)."
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      >
        <RefundsTabs needPerson={needPerson} openIncidents={openIncidents} />
      </PanelHeader>

      <section aria-labelledby="refund-stats-heading" className="space-y-3">
        <h2 id="refund-stats-heading" className="sr-only">
          Refunds at a glance
        </h2>
        {stats ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatTile
              label="Need a person"
              value={formatCount(needPerson)}
              hint="Held, failed or stuck"
              href={href({ status: [...REFUND_NEEDS_PERSON], page: 1 })}
              tone={needPerson ? 'warning' : 'neutral'}
            />
            <StatTile
              label="Oldest open refund"
              value={stats.openOldestAt ? ago(stats.openOldestAt, now) : 'None open'}
              hint={stats.openOldestAt ? `Since ${formatWat(stats.openOldestAt)}` : undefined}
            />
            <StatTile
              label="Typical time to refund"
              value={
                stats.medianHoursToComplete === null ? '—' : `${stats.medianHoursToComplete} h`
              }
              hint={
                stats.medianHoursToComplete === null
                  ? 'None completed in the last 90 days'
                  : 'Median, last 90 days'
              }
            />
            <StatTile
              label="Sent in the last 24 hours"
              value={naira(stats.sent24hKobo)}
              hint={`Daily automatic limit: ${naira(stats.limits.dailyKobo)}`}
            />
            <StatTile
              label="Automatic limit per refund"
              value={naira(stats.limits.singleKobo)}
              hint={`Above it, or past the daily limit, a refund is held for approval. A refund normally waits ${stats.limits.delayMinutes} min before it is sent.`}
            />
          </div>
        ) : (
          <ErrorState
            title="The refund figures couldn't be loaded."
            body="Nothing was changed. The list below may still load; try again for the figures and limits."
          />
        )}
      </section>

      <Panel labelledBy="refund-filters-heading" className="space-y-4">
        <h2 id="refund-filters-heading" className="font-medium text-foreground">
          Find refunds
        </h2>
        <TableToolbar
          action={BASE}
          label="Order number"
          placeholder="Order number, such as ND-001234"
          defaultValue={q}
          keep={{
            status: params.status.join(',') || undefined,
            reason: reasons.join(',') || undefined,
            from: params.from ?? undefined,
            to: params.to ?? undefined,
          }}
        />
        <FilterChips
          label="Status"
          chips={REFUND_STATUSES.map((status) => ({
            value: status,
            label: labelFor(REFUND_STATUS_LABEL, status),
            ...(stats ? { count: byStatus.get(status) ?? 0 } : {}),
          }))}
          selected={params.status}
          href={(value) => href({ status: toggled(params.status, value as RefundStatus) })}
          allHref={href({ status: [] })}
        />
        <FilterChips
          label="Reason"
          chips={REFUND_REASONS.map((reason) => ({
            value: reason,
            label: labelFor(REFUND_REASON_LABEL, reason),
            ...(stats ? { count: byReason.get(reason) ?? 0 } : {}),
          }))}
          selected={reasons}
          href={(value) => href({ reasons: toggled(reasons, value as RefundReason) })}
          allHref={href({ reasons: [] })}
        />
        <form
          action={BASE}
          method="get"
          className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
        >
          {params.status.length > 0 ? (
            <input type="hidden" name="status" value={params.status.join(',')} />
          ) : null}
          {reasons.length > 0 ? (
            <input type="hidden" name="reason" value={reasons.join(',')} />
          ) : null}
          {q ? <input type="hidden" name="q" value={q} /> : null}
          <div>
            <label htmlFor="refunds-from" className="text-sm font-medium text-foreground">
              Created from
            </label>
            <input
              id="refunds-from"
              type="date"
              name="from"
              defaultValue={params.from ?? ''}
              className={cn(inputClass, 'mt-1.5 sm:w-44')}
            />
          </div>
          <div>
            <label htmlFor="refunds-to" className="text-sm font-medium text-foreground">
              Created to
            </label>
            <input
              id="refunds-to"
              type="date"
              name="to"
              defaultValue={params.to ?? ''}
              className={cn(inputClass, 'mt-1.5 sm:w-44')}
            />
          </div>
          <button type="submit" className={QUIET_LINK}>
            Apply dates
          </button>
          {params.from || params.to ? (
            <Link href={href({ from: null, to: null })} className={QUIET_LINK}>
              Clear dates
            </Link>
          ) : null}
        </form>
        {badQuery ? (
          <p role="status" className="text-sm text-foreground">
            Search by order number only, such as ND-001234. Customer details are searched on the
            Customers page.
          </p>
        ) : null}
      </Panel>

      {list.ok ? (
        <>
          <DataTable
            caption={`Refunds, ${side === 'test' ? 'Test' : 'Live'} side`}
            rows={list.rows}
            columns={columns}
            rowKey={(row) => row.id}
            sorting={{
              sort: params.sort,
              dir: params.dir,
              href: (sort) => href(nextSort(params, sort)),
            }}
            empty={
              <EmptyState
                title={
                  filtered
                    ? 'No refunds match these filters'
                    : `No refunds on the ${side === 'test' ? 'Test' : 'Live'} side yet`
                }
                body={
                  filtered
                    ? 'Clear a filter, or show every refund.'
                    : 'A refund appears here when a paid line fails or a charge needs returning.'
                }
                action={
                  filtered ? (
                    <Link href={BASE} className={QUIET_LINK}>
                      Show every refund
                    </Link>
                  ) : undefined
                }
              />
            }
          />
          {list.rows.length > 0 ? (
            <Pager
              page={params.page}
              pageCount={pageCount(list.total, params.per)}
              total={list.total}
              href={(page) => href({ page })}
            />
          ) : null}
        </>
      ) : (
        <ErrorState title="The refunds couldn't be loaded." />
      )}
    </PanelPage>
  )
}
