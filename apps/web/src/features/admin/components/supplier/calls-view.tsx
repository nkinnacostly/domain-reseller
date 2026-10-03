import Link from 'next/link'
import { Suspense } from 'react'
import { FOCUS, PANEL_HEADING, Panel, PanelPage, PanelSkeleton } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { formatCount, formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  CALL_OPERATIONS,
  CALL_OUTCOME_LABEL,
  CALL_OUTCOME_TONE,
  CALL_OUTCOMES,
  type CallOutcome,
  type CallSort,
  type CallsSearch,
  callsHref,
  defaultSummaryRange,
  formatDuration,
  operationLabel,
  parseCallsSearch,
} from '@/features/admin/lib/supplier-calls'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { type CallRow, getCallSummary, getCalls } from '@/features/admin/queries/supplier'
import { cn } from '@/lib/utils'
import { SupplierHeader } from './supplier-header'

export type CallsPageSearch = Record<string, string | string[] | undefined>

/**
 * `/admin/supplier/calls` (docs/ADMIN-SPEC.md §5.2 B6; I7): every
 * provisioning call the gateway recorded on the side's environment — what it
 * asked, how it ended, how long it took and the job it was for — with a
 * summary by operation. Searches are never recorded (FR-S7). Read only.
 */
export async function CallsView({ searchParams }: { searchParams: Promise<CallsPageSearch> }) {
  const admin = await requireAdmin()
  const [side, search] = await Promise.all([getAdminSide(admin), searchParams])
  const params = parseCallsSearch(search)
  const now = new Date()
  return (
    <PanelPage>
      <SupplierHeader
        title="Supplier calls"
        description={`Every provisioning call the gateway made to DomainNameAPI on the ${side === 'test' ? 'sandbox (test)' : 'live'} side, and how it ended. Searches are never recorded.`}
        side={side}
        testOnly={admin.testOnly}
      />
      <Suspense fallback={<PanelSkeleton height="h-48" />}>
        <CallSummary side={side} params={params} now={now} />
      </Suspense>
      <Suspense fallback={<TableSkeleton rows={8} />}>
        <CallsList admin={admin} side={side} params={params} />
      </Suspense>
    </PanelPage>
  )
}

export async function CallSummary({
  side,
  params,
  now,
}: {
  side: AdminSide
  params: CallsSearch
  now: Date
}) {
  const fallback = defaultSummaryRange(now)
  const asked = [params.from ?? fallback.from, params.to ?? fallback.to].sort()
  const from = asked[0] as string
  const to = asked[1] as string
  const rows = await getCallSummary(side, from, to)
  if (!rows) return <ErrorState title="The calls summary couldn't be loaded." />
  return (
    <Panel labelledBy="supplier-calls-summary-heading">
      <h2 id="supplier-calls-summary-heading" className={PANEL_HEADING}>
        By operation
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {from === to ? `On ${from}` : `From ${from} to ${to}`} (Lagos days): how many, and how long
        the middle and the slowest twentieth took.
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-border border-dashed bg-background/70 px-4 py-8 text-center text-sm text-muted-foreground">
          No calls recorded in this range.
        </p>
      ) : (
        <div className="relative mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Supplier calls by operation and outcome</caption>
            <thead>
              <tr className="border-border border-b text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Operation
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Outcome
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Calls
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Median
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  95th percentile
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.operation}:${row.outcome}`}
                  className="border-border border-b last:border-b-0"
                >
                  <th scope="row" className="py-2 pr-4 text-left font-normal text-foreground">
                    {operationLabel(row.operation)}
                  </th>
                  <td className="py-2 pr-4">
                    <OutcomePill outcome={row.outcome} />
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatCount(row.count)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatDuration(row.p50Ms)}</td>
                  <td className="py-2 text-right tabular-nums">{formatDuration(row.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function OutcomePill({ outcome }: { outcome: string }) {
  const known = (CALL_OUTCOMES as readonly string[]).includes(outcome)
  return (
    <AdminStatusPill
      value={outcome}
      labels={CALL_OUTCOME_LABEL}
      tone={known ? CALL_OUTCOME_TONE[outcome as CallOutcome] : 'neutral'}
    />
  )
}

export async function CallsList({
  admin,
  side,
  params,
}: {
  admin: AdminPrincipal
  side: AdminSide
  params: CallsSearch
}) {
  const page = await getCalls(admin, side, params)
  if (!page) return <ErrorState title="The calls couldn't be loaded." />

  const columns: Column<CallRow, CallSort>[] = [
    {
      key: 'when',
      header: 'When',
      sort: 'created',
      cell: (row) => <span className="whitespace-nowrap">{formatWat(row.createdAt)}</span>,
    },
    {
      key: 'operation',
      header: 'Operation',
      cell: (row) => (
        <span>
          {operationLabel(row.operation)}
          {operationLabel(row.operation) !== row.operation ? (
            <span className="block font-mono text-xs text-muted-foreground">{row.operation}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'domain',
      header: 'Domain',
      cell: (row) => <span className="break-all">{row.domainName ?? '—'}</span>,
    },
    { key: 'outcome', header: 'Outcome', cell: (row) => <OutcomePill outcome={row.outcome} /> },
    {
      key: 'code',
      header: 'Code',
      cell: (row) =>
        row.errorCode || row.httpStatus ? (
          <span className="font-mono text-xs">
            {[row.errorCode, row.httpStatus ? `HTTP ${row.httpStatus}` : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'duration',
      header: 'Took',
      sort: 'duration',
      numeric: true,
      cell: (row) => formatDuration(row.durationMs),
    },
    {
      key: 'job',
      header: 'Job',
      cell: (row) =>
        row.jobId ? (
          <Link
            href={adminHref.job(row.jobId)}
            className={cn('inline-flex min-h-11 items-center underline underline-offset-2', FOCUS)}
          >
            Open the job
          </Link>
        ) : row.sslJobId ? (
          <Link
            href={adminHref.sslJob(row.sslJobId)}
            className={cn('inline-flex min-h-11 items-center underline underline-offset-2', FOCUS)}
          >
            Open the certificate job
          </Link>
        ) : (
          '—'
        ),
    },
  ]

  const toggle = (value: string) =>
    callsHref(params, {
      status: params.status.includes(value as CallOutcome)
        ? params.status.filter((s) => s !== value)
        : [...params.status, value as CallOutcome],
    })
  const filtered =
    params.status.length > 0 || Boolean(params.op || params.job || params.from || params.to)

  return (
    <Panel labelledBy="supplier-calls-heading">
      <h2 id="supplier-calls-heading" className={PANEL_HEADING}>
        Calls
      </h2>
      <div className="mt-3 space-y-3">
        <FilterChips
          label="Outcome"
          chips={CALL_OUTCOMES.map((value) => ({ value, label: CALL_OUTCOME_LABEL[value] }))}
          selected={params.status}
          href={toggle}
          allHref={callsHref(params, { status: [] })}
        />
        <form
          action="/admin/supplier/calls"
          method="get"
          aria-label="Operation and dates"
          className="flex flex-wrap items-end gap-3"
        >
          {params.status.length > 0 ? (
            <input type="hidden" name="status" value={params.status.join(',')} />
          ) : null}
          {params.job ? <input type="hidden" name="job" value={params.job} /> : null}
          <label className="grid w-full min-w-0 gap-1.5 text-sm font-medium text-foreground sm:w-auto">
            Operation
            <select
              name="op"
              defaultValue={params.op ?? ''}
              className="h-11 w-full min-w-0 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:w-64 sm:text-sm"
            >
              <option value="">Every operation</option>
              {CALL_OPERATIONS.map((op) => (
                <option key={op} value={op}>
                  {operationLabel(op)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            From
            <input
              type="date"
              name="from"
              defaultValue={params.from ?? ''}
              className="h-11 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:text-sm"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            To
            <input
              type="date"
              name="to"
              defaultValue={params.to ?? ''}
              className="h-11 rounded-xl border border-input bg-background px-3 text-base text-foreground sm:text-sm"
            />
          </label>
          <button
            type="submit"
            className={cn(
              'inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98]',
              FOCUS,
            )}
          >
            Show
          </button>
        </form>
        {params.job ? (
          <p className="text-sm text-muted-foreground">
            Showing one job's calls.{' '}
            <Link
              href={callsHref(params, { job: null })}
              className={cn('font-medium text-foreground underline underline-offset-2', FOCUS)}
            >
              Show every call
            </Link>
          </p>
        ) : null}
      </div>
      <DataTable
        caption="Supplier calls"
        rows={page.rows}
        rowKey={(row) => String(row.id)}
        columns={columns}
        className="mt-4"
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => callsHref(params, nextSort(params, sort)),
        }}
        empty={
          <EmptyState
            className="mt-4"
            title={
              filtered ? 'No calls match these filters.' : 'No calls recorded on this side yet.'
            }
            {...(filtered
              ? {
                  action: (
                    <Link
                      href="/admin/supplier/calls"
                      className={cn(
                        'inline-flex h-11 items-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted active:scale-[0.98]',
                        FOCUS,
                      )}
                    >
                      Clear the filters
                    </Link>
                  ),
                }
              : {
                  body: 'Registrations, renewals, transfers, nameserver changes and admin reads appear here as the gateway makes them.',
                })}
          />
        }
      />
      {page.rows.length > 0 ? (
        <div className="mt-4">
          <Pager
            page={params.page}
            pageCount={pageCount(page.total, params.per)}
            total={page.total}
            href={(n) => callsHref(params, { page: n })}
          />
        </div>
      ) : null}
    </Panel>
  )
}
