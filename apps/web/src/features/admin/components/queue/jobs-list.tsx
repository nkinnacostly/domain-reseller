import Link from 'next/link'
import { RefreshWhile } from '@/components/common/refresh-while'
import { FOCUS, Panel } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import { formatWat, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { JOB_KIND_LABEL, JOB_STATUS_LABEL, labelFor } from '@/features/admin/lib/labels'
import type { ListParams } from '@/features/admin/lib/list-params'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import {
  filtersActive,
  hasOpenJob,
  JOB_STATUSES,
  type JobFilters,
  type JobSort,
  type JobStatus,
  jobsHref,
} from '@/features/admin/lib/queue-facts'
import type { JobRow, SslJobRow } from '@/features/admin/queries/queue'
import { cn } from '@/lib/utils'
import { DateRangeForm } from './date-range-form'

/** How often an open list re-reads itself (§5.2: RefreshWhile, 10 s). */
export const QUEUE_REFRESH_MS = 10_000

const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

function StatusCell({ status, testMode }: { status: string; testMode: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <AdminStatusPill value={status} labels={JOB_STATUS_LABEL} />
      {testMode ? <TestBadge /> : null}
    </span>
  )
}

function Code({ value }: { value: string | null }) {
  return value ? <code className="font-mono text-xs break-words">{value}</code> : <>—</>
}

/** The filters every queue list shares: status, kind and the days it was made. */
function ListFilters({
  base,
  params,
  filters,
  kinds,
}: {
  base: string
  params: ListParams<JobSort, JobStatus>
  filters: JobFilters
  kinds: readonly string[]
}) {
  const toggleStatus = (value: string) => {
    const status = params.status.includes(value as JobStatus)
      ? params.status.filter((current) => current !== value)
      : [...params.status, value as JobStatus]
    return jobsHref(base, params, filters, { status })
  }
  return (
    <div className="space-y-3">
      <FilterChips
        label="Status"
        chips={JOB_STATUSES.map((status) => ({
          value: status,
          label: labelFor(JOB_STATUS_LABEL, status),
        }))}
        selected={params.status}
        href={toggleStatus}
        allHref={jobsHref(base, params, filters, { status: [] })}
      />
      <FilterChips
        label="Kind"
        chips={kinds.map((kind) => ({ value: kind, label: labelFor(JOB_KIND_LABEL, kind) }))}
        selected={filters.kind ? [filters.kind] : []}
        href={(kind) =>
          jobsHref(base, params, filters, { kind: filters.kind === kind ? null : kind })
        }
        allHref={jobsHref(base, params, filters, { kind: null })}
      />
      <DateRangeForm
        action={base}
        from={params.from}
        to={params.to}
        keep={{
          status: params.status.length > 0 ? params.status.join(',') : null,
          kind: filters.kind,
          domain: filters.domainId,
          sort: params.sort === 'created' ? null : params.sort,
          dir: params.dir === 'desc' ? null : params.dir,
          per: params.per === 25 ? null : String(params.per),
        }}
        clearHref={jobsHref(base, params, filters, { from: null, to: null })}
      />
    </div>
  )
}

function sorting(base: string, params: ListParams<JobSort, JobStatus>, filters: JobFilters) {
  return {
    sort: params.sort,
    dir: params.dir,
    href: (sort: JobSort) => jobsHref(base, params, filters, nextSort(params, sort)),
  }
}

function NoRows({ base, active, noun }: { base: string; active: boolean; noun: string }) {
  return active ? (
    <EmptyState
      title={`No ${noun} match these filters.`}
      action={
        <Link href={base} className={LINK}>
          Clear the filters
        </Link>
      }
    />
  ) : (
    <EmptyState
      title={`No ${noun} on this side yet.`}
      body="Paid orders and customers' settings changes queue them; they appear here as the worker takes them."
    />
  )
}

/** Registration, renewal, transfer and settings jobs (§5.2 B4). */
export function JobsTable({
  rows,
  total,
  params,
  filters,
  kinds,
}: {
  rows: JobRow[]
  total: number
  params: ListParams<JobSort, JobStatus>
  filters: JobFilters
  kinds: readonly string[]
}) {
  const base = '/admin/queue'
  const columns: Column<JobRow, JobSort>[] = [
    {
      key: 'job',
      header: 'Job',
      cell: (row) => (
        <Link href={adminHref.job(row.id)} className={cn(LINK, 'inline-block min-w-0')}>
          <span className="block">{labelFor(JOB_KIND_LABEL, row.kind)}</span>
          <span className="block font-normal break-words text-muted-foreground">
            {row.domainName ?? `Domain ${shortId(row.domainId)}`}
          </span>
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <StatusCell status={row.status} testMode={row.testMode} />,
    },
    { key: 'error', header: 'Last error', cell: (row) => <Code value={row.lastErrorCode} /> },
    {
      key: 'attempts',
      header: 'Attempts',
      sort: 'attempts',
      numeric: true,
      cell: (row) => row.attempts,
    },
    {
      key: 'next',
      header: 'Next try',
      sort: 'next',
      cell: (row) => (row.status === 'queued' ? formatWat(row.runAfter) : '—'),
    },
    { key: 'created', header: 'Made', sort: 'created', cell: (row) => formatWat(row.createdAt) },
    { key: 'updated', header: 'Updated', sort: 'updated', cell: (row) => formatWat(row.updatedAt) },
  ]
  return (
    <Panel labelledBy="queue-jobs-heading" className="space-y-4">
      <h2 id="queue-jobs-heading" className="font-medium text-foreground">
        Jobs
      </h2>
      <ListFilters base={base} params={params} filters={filters} kinds={kinds} />
      {filters.domainId ? (
        <p className="text-sm text-muted-foreground">
          One domain's jobs only.{' '}
          <Link href={jobsHref(base, params, { ...filters, domainId: null })} className={LINK}>
            Show every domain
          </Link>
        </p>
      ) : null}
      <DataTable
        caption="Jobs, newest first unless sorted"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        sorting={sorting(base, params, filters)}
        empty={<NoRows base={base} active={filtersActive(params, filters)} noun="jobs" />}
      />
      <Pager
        page={params.page}
        pageCount={pageCount(total, params.per)}
        total={total}
        href={(page) => jobsHref(base, params, filters, { page })}
      />
      <RefreshWhile active={hasOpenJob(rows)} everyMs={QUEUE_REFRESH_MS} />
    </Panel>
  )
}

/** Certificate order, set-up and reissue jobs (§5.2 B4). */
export function SslJobsTable({
  rows,
  total,
  params,
  filters,
  kinds,
}: {
  rows: SslJobRow[]
  total: number
  params: ListParams<JobSort, JobStatus>
  filters: JobFilters
  kinds: readonly string[]
}) {
  const base = '/admin/queue/ssl-jobs'
  const columns: Column<SslJobRow, JobSort>[] = [
    {
      key: 'job',
      header: 'Job',
      cell: (row) => (
        <Link href={adminHref.sslJob(row.id)} className={cn(LINK, 'inline-block min-w-0')}>
          <span className="block">{labelFor(JOB_KIND_LABEL, row.kind)}</span>
          <span className="block font-normal text-muted-foreground">
            Certificate {shortId(row.certificateId)}
          </span>
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <StatusCell status={row.status} testMode={row.testMode} />,
    },
    {
      key: 'sent',
      header: 'Sent to the supplier',
      cell: (row) => (row.sentAt ? formatWat(row.sentAt) : 'Not sent'),
    },
    { key: 'error', header: 'Last error', cell: (row) => <Code value={row.lastErrorCode} /> },
    {
      key: 'attempts',
      header: 'Attempts',
      sort: 'attempts',
      numeric: true,
      cell: (row) => row.attempts,
    },
    { key: 'created', header: 'Made', sort: 'created', cell: (row) => formatWat(row.createdAt) },
    { key: 'updated', header: 'Updated', sort: 'updated', cell: (row) => formatWat(row.updatedAt) },
  ]
  return (
    <Panel labelledBy="queue-ssl-heading" className="space-y-4">
      <h2 id="queue-ssl-heading" className="font-medium text-foreground">
        Certificate jobs
      </h2>
      <ListFilters base={base} params={params} filters={filters} kinds={kinds} />
      <DataTable
        caption="Certificate jobs, newest first unless sorted"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        sorting={sorting(base, params, filters)}
        empty={
          <NoRows base={base} active={filtersActive(params, filters)} noun="certificate jobs" />
        }
      />
      <Pager
        page={params.page}
        pageCount={pageCount(total, params.per)}
        total={total}
        href={(page) => jobsHref(base, params, filters, { page })}
      />
      <RefreshWhile active={hasOpenJob(rows)} everyMs={QUEUE_REFRESH_MS} />
    </Panel>
  )
}
