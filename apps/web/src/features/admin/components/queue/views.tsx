import { redirect } from 'next/navigation'
import { PanelPage } from '@/components/layout/panel'
import { ErrorState } from '@/features/admin/components/error-state'
import { parseListParams } from '@/features/admin/lib/list-params'
import {
  DOMAIN_JOB_KINDS,
  JOB_LIST_SPEC,
  type JobFilters,
  parseKind,
  parseUuid,
  SSL_JOB_KINDS,
  tabRedirect,
} from '@/features/admin/lib/queue-facts'
import {
  getJob,
  getQueueStats,
  getSslJob,
  listJobs,
  listPendingWithoutJob,
  listSslJobs,
} from '@/features/admin/queries/queue'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { JobDetailBody, JobNotFound } from './job-detail'
import { JobsTable, SslJobsTable } from './jobs-list'
import { PendingTable } from './pending-list'
import { QueueHeader } from './queue-header'
import { QueueStatsPanel } from './queue-stats'
import { SslJobDetailBody } from './ssl-job-detail'

/**
 * The queue's pages (docs/ADMIN-SPEC.md §5.2 B4), each awaited inside its
 * route's Suspense: the admin asked of SQL first, then the side, then the
 * URL, then the reads. A read that fails shows its error state with "Try
 * again" — never an empty list that would read as "nothing to do".
 */

export type Search = Record<string, string | string[] | undefined>

const READ_FAILED = "The queue couldn't be read."

export async function JobsView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const search = await searchParams
  const moved = tabRedirect(search)
  if (moved) redirect(moved)
  const params = parseListParams(search, JOB_LIST_SPEC)
  const filters: JobFilters = {
    kind: parseKind(search, DOMAIN_JOB_KINDS),
    domainId: parseUuid(search.domain),
  }
  const [page, stats] = await Promise.allSettled([
    listJobs(admin, side, params, filters),
    getQueueStats(admin, side, new Date()),
  ])
  return (
    <PanelPage>
      <QueueHeader side={side} testOnly={admin.testOnly} />
      {stats.status === 'fulfilled' ? (
        <QueueStatsPanel stats={stats.value} />
      ) : (
        <ErrorState title="The queue's figures couldn't be read." />
      )}
      {page.status === 'fulfilled' ? (
        <JobsTable
          rows={page.value.rows}
          total={page.value.total}
          params={params}
          filters={filters}
          kinds={DOMAIN_JOB_KINDS}
        />
      ) : (
        <ErrorState title={READ_FAILED} />
      )}
    </PanelPage>
  )
}

export async function SslJobsView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const search = await searchParams
  const params = parseListParams(search, JOB_LIST_SPEC)
  const filters: JobFilters = { kind: parseKind(search, SSL_JOB_KINDS), domainId: null }
  const page = await listSslJobs(admin, side, params, filters).then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  )
  return (
    <PanelPage>
      <QueueHeader side={side} testOnly={admin.testOnly} />
      {page.ok ? (
        <SslJobsTable
          rows={page.value.rows}
          total={page.value.total}
          params={params}
          filters={filters}
          kinds={SSL_JOB_KINDS}
        />
      ) : (
        <ErrorState title={READ_FAILED} />
      )}
    </PanelPage>
  )
}

export async function PendingView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const now = new Date()
  const report = await listPendingWithoutJob(admin, side, now).then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  )
  return (
    <PanelPage>
      <QueueHeader side={side} testOnly={admin.testOnly} />
      {report.ok ? (
        <PendingTable report={report.value} now={now} />
      ) : (
        <ErrorState title="The paid lines couldn't be read." />
      )}
    </PanelPage>
  )
}

export async function JobView({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const id = parseUuid((await params).id)
  const now = new Date()
  const detail = id
    ? await getJob(admin, side, id).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
    : { ok: true as const, value: null }
  return (
    <PanelPage>
      {!detail.ok ? (
        <>
          <QueueHeader side={side} testOnly={admin.testOnly} />
          <ErrorState title="This job couldn't be read." />
        </>
      ) : detail.value ? (
        <JobDetailBody detail={detail.value} side={side} viewer={admin} now={now} />
      ) : (
        <>
          <QueueHeader side={side} testOnly={admin.testOnly} />
          <JobNotFound side={side} />
        </>
      )}
    </PanelPage>
  )
}

export async function SslJobView({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const id = parseUuid((await params).id)
  const detail = id
    ? await getSslJob(admin, side, id).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
    : { ok: true as const, value: null }
  return (
    <PanelPage>
      {!detail.ok ? (
        <>
          <QueueHeader side={side} testOnly={admin.testOnly} />
          <ErrorState title="This certificate job couldn't be read." />
        </>
      ) : detail.value ? (
        <SslJobDetailBody detail={detail.value} side={side} viewer={admin} />
      ) : (
        <>
          <QueueHeader side={side} testOnly={admin.testOnly} />
          <JobNotFound side={side} noun="certificate job" />
        </>
      )}
    </PanelPage>
  )
}
