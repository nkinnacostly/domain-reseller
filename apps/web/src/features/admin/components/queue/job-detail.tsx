import { formatNaira } from '@dr/shared/pricing'
import Link from 'next/link'
import { RefreshWhile } from '@/components/common/refresh-while'
import { FOCUS, Panel, PanelHeader } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { DlGrid, type DlItem } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Timeline, type TimelineEvent } from '@/features/admin/components/timeline'
import { canAct } from '@/features/admin/lib/actions'
import { formatWat, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import {
  failOffer,
  failRequirement,
  type JobFacts,
  lastReadWords,
  type Offer,
  readVerdictWords,
  retryOffer,
} from '@/features/admin/lib/jobs-copy'
import {
  JOB_KIND_LABEL,
  JOB_STATUS_LABEL,
  LINE_STATUS_LABEL,
  labelFor,
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
} from '@/features/admin/lib/labels'
import { playbookFor } from '@/features/admin/lib/playbook'
import {
  failRefundKobo,
  hasOpenJob,
  LINE_KIND_LABEL,
  lineRefundKobo,
  openLineRefund,
  type ReadCall,
  readVerdict,
  refundAtProvider,
} from '@/features/admin/lib/queue-facts'
import type { AdminSide } from '@/features/admin/lib/side'
import type { JobDetail, SupplierCallRow } from '@/features/admin/queries/queue'
import { cn } from '@/lib/utils'
import { JobActions } from './job-actions'
import { QUEUE_REFRESH_MS } from './jobs-list'
import { LiveRead, type LiveReadKind } from './live-read'

const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

export type Viewer = { role: 'owner' | 'operator' | 'viewer'; testOnly: boolean }

const sentence = (value: string) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ') : value

/** A job this side does not hold: the link is wrong, or it is on the other side. */
export function JobNotFound({ side, noun = 'job' }: { side: AdminSide; noun?: string }) {
  return (
    <EmptyState
      title={`This ${noun} isn't on the ${side === 'test' ? 'Test' : 'Live'} side.`}
      body="It may be on the other side — switch sides above — or the link may be wrong."
      action={
        <Link href="/admin/queue" className={LINK}>
          Back to the queue
        </Link>
      }
    />
  )
}

/** The supplier calls a job made, newest first: operations and outcomes, never a raw message (N10). */
export function CallTrace({ calls, empty }: { calls: SupplierCallRow[]; empty: string }) {
  const columns: Column<SupplierCallRow>[] = [
    { key: 'at', header: 'When', cell: (call) => formatWat(call.createdAt) },
    {
      key: 'operation',
      header: 'Operation',
      cell: (call) => <code className="font-mono text-xs">{call.operation}</code>,
    },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (call) => <AdminStatusPill value={call.outcome} />,
    },
    {
      key: 'code',
      header: 'Code',
      cell: (call) =>
        call.errorCode ? <code className="font-mono text-xs">{call.errorCode}</code> : '—',
    },
    { key: 'http', header: 'HTTP', numeric: true, cell: (call) => call.httpStatus ?? '—' },
    {
      key: 'duration',
      header: 'Took',
      numeric: true,
      cell: (call) => `${(call.durationMs / 1000).toFixed(1)} s`,
    },
  ]
  return (
    <DataTable
      caption="Supplier calls, newest first"
      rows={calls}
      columns={columns}
      rowKey={(call) => String(call.id)}
      empty={<p className="text-sm text-muted-foreground">{empty}</p>}
    />
  )
}

/** Words for an offer that is not made, when there is something to say. */
function NotOffered({ offer }: { offer: Offer<unknown> }) {
  if (offer.offered || !offer.words) return null
  return <p className="max-w-2xl text-sm/6 text-muted-foreground">{offer.words}</p>
}

/** The playbook card: what the code means and what to do (DEPLOY §6). */
export function PlaybookCard({ code }: { code: string | null }) {
  const entry = playbookFor(code)
  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="text-sm text-muted-foreground">
        Playbook
        {code ? (
          <>
            {' · '}
            <code className="font-mono text-xs text-foreground">{code}</code>
          </>
        ) : null}
      </p>
      <p className="mt-2 text-sm/6 text-foreground">{entry.meaning}</p>
      <p className="mt-1 text-sm/6 text-foreground">{entry.next}</p>
    </div>
  )
}

/** The read Fail needs, its last result, and the button that makes a new one. */
function FailPrecondition({
  read,
  last,
  lastAttemptAt,
  now,
  name,
  canRead,
  returnTo,
}: {
  read: 'registry' | 'transfer'
  last: ReadCall | null
  lastAttemptAt: string | null
  now: Date
  name: string
  canRead: boolean
  returnTo: string
}) {
  const verdict = readVerdict(read, last, lastAttemptAt, now)
  return (
    <Panel labelledBy="job-precondition-heading" className="space-y-3">
      <h2 id="job-precondition-heading" className="font-medium text-foreground">
        Before failing
      </h2>
      <p className="max-w-2xl text-sm/6 text-muted-foreground">{failRequirement(read)}</p>
      <p className="text-sm text-foreground">
        {lastReadWords(read, last)}{' '}
        <span data-verdict={verdict}>{readVerdictWords(verdict, read)}</span>
      </p>
      {read === 'registry' ? (
        <p className="max-w-2xl text-sm/6 text-muted-foreground">
          The database also refuses Fail when DomainNameAPI's ledger shows a charge for {name} since
          this job started.
        </p>
      ) : null}
      {canRead ? (
        <LiveRead
          kind={read === 'registry' ? 'registry' : 'transfer'}
          name={name}
          returnTo={returnTo}
        />
      ) : null}
    </Panel>
  )
}

function jobFacts(detail: JobDetail): JobFacts {
  const open = openLineRefund(detail.refunds)
  const share =
    detail.line && detail.order
      ? lineRefundKobo(detail.orderLines, detail.order, detail.line.id)
      : null
  return {
    kind: detail.job.kind,
    status: detail.job.status,
    lastErrorCode: detail.job.lastErrorCode,
    name: detail.domain?.name ?? null,
    pendingRefundKobo: open && !refundAtProvider(open) ? open.amountKobo : null,
    refundAtProvider: refundAtProvider(open),
    failRefundKobo: failRefundKobo(detail.refunds, share),
    pendingTransferLock: detail.domain?.pendingTransferLock ?? null,
    sentAt: null,
  }
}

/** The live reads that help with this job (§5.2 B4, DEPLOY §6). */
function readsFor(detail: JobDetail): LiveReadKind[] {
  const reads: LiveReadKind[] = ['registry']
  if (detail.job.kind === 'transfer_domain') reads.push('transfer')
  if (
    detail.job.kind === 'renew_domain' ||
    detail.job.lastErrorCode === 'NOT_RENEWABLE' ||
    detail.line?.failureCode === 'NOT_RENEWABLE'
  ) {
    reads.push('renew')
  }
  return reads
}

function timeline(detail: JobDetail): TimelineEvent[] {
  const { job } = detail
  const events: TimelineEvent[] = detail.events.map((event) => ({
    id: `event-${event.id}`,
    at: event.createdAt,
    title: sentence(event.eventType),
    detail: event.actorType === 'system' ? undefined : `By ${event.actorType}`,
  }))
  events.push({ id: 'job-made', at: job.createdAt, title: 'Job made', tone: 'info' })
  if (job.submittedAt) {
    events.push({
      id: 'job-submitted',
      at: job.submittedAt,
      title: 'Transfer submitted to the registry',
    })
  }
  if (job.finishedAt) {
    events.push({
      id: 'job-finished',
      at: job.finishedAt,
      title: `Job ${labelFor(JOB_STATUS_LABEL, job.status).toLowerCase()}`,
      tone: job.status === 'succeeded' ? 'ok' : 'danger',
    })
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

export function JobDetailBody({
  detail,
  side,
  viewer,
  now,
}: {
  detail: JobDetail
  side: AdminSide
  viewer: Viewer
  now: Date
}) {
  const { job, domain, line } = detail
  const returnTo = adminHref.job(job.id)
  const kindLabel = labelFor(JOB_KIND_LABEL, job.kind)
  const facts = jobFacts(detail)
  const retry = retryOffer(facts)
  const fail = failOffer(facts)
  const mayRetry = canAct(viewer, 'job.retry')
  const mayFail = canAct(viewer, 'job.fail')
  const mayRead = canAct(viewer, 'supplier.domain_lookup')
  const open = job.status === 'queued' || job.status === 'running'
  const needsRead = fail.offered && mayFail ? fail.copy.needsRead : null

  const summary: DlItem[] = [
    { label: 'Kind', value: kindLabel },
    {
      label: 'Status',
      value: <AdminStatusPill value={job.status} labels={JOB_STATUS_LABEL} />,
    },
    {
      label: 'Domain',
      value: domain ? (
        <Link href={adminHref.domain(domain.id)} className={cn(LINK, 'break-words')}>
          {domain.name}
        </Link>
      ) : (
        `Domain ${shortId(job.domainId)}`
      ),
    },
    {
      label: 'Last error',
      value: job.lastErrorCode ? (
        <code className="font-mono text-sm">{job.lastErrorCode}</code>
      ) : (
        'None'
      ),
    },
    { label: 'Attempts', value: job.attempts },
    { label: 'Made', value: formatWat(job.createdAt) },
    { label: 'Next try', value: job.status === 'queued' ? formatWat(job.runAfter) : '—' },
    { label: 'Updated', value: formatWat(job.updatedAt) },
    { label: 'Finished', value: formatWat(job.finishedAt) },
  ]
  if (job.kind === 'transfer_domain') {
    summary.push({
      label: 'Submitted to the registry',
      value: job.submittedAt ? formatWat(job.submittedAt) : 'Not yet: its code is still held',
    })
  }
  if (job.kind === 'renew_domain') {
    summary.push({
      label: 'Expiry stored before renewing',
      value: job.baselineExpiry ? formatWat(job.baselineExpiry) : 'Not stored yet',
    })
  }
  if (job.lockedBy) {
    summary.push({
      label: 'Held by worker',
      value: `${job.lockedBy} since ${formatWat(job.lockedAt)}`,
    })
  }

  return (
    <>
      <PanelHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Queue', href: '/admin/queue' },
          { label: kindLabel },
        ]}
        title={<span className="break-all">{domain?.name ?? `Job ${shortId(job.id)}`}</span>}
        titleAside={
          <span className="inline-flex flex-wrap items-center gap-2">
            <AdminStatusPill value={job.status} labels={JOB_STATUS_LABEL} />
            {job.testMode ? <TestBadge /> : null}
          </span>
        }
        description={`${kindLabel} · job ${shortId(job.id)}`}
        actions={<SideSwitch side={side} testOnly={viewer.testOnly} />}
      />

      <Panel labelledBy="job-next-heading" className="space-y-4">
        <h2 id="job-next-heading" className="font-medium text-foreground">
          What to do
        </h2>
        {open ? (
          <p className="text-sm/6 text-muted-foreground">
            The worker has this job. The page reads it again every 10 seconds until it settles.
          </p>
        ) : job.status === 'succeeded' ? (
          <p className="text-sm/6 text-muted-foreground">Done. Nothing to do.</p>
        ) : (
          <PlaybookCard code={job.lastErrorCode} />
        )}
        {mayRetry || mayFail ? (
          <>
            <JobActions
              jobId={job.id}
              certificate={false}
              retry={mayRetry && retry.offered ? retry.copy : null}
              fail={mayFail && fail.offered ? fail.copy : null}
              typeToConfirm={domain?.name ?? shortId(job.id)}
              returnTo={returnTo}
            />
            <NotOffered offer={retry} />
            <NotOffered offer={fail} />
          </>
        ) : job.status === 'needs_attention' || job.status === 'failed' ? (
          <p className="text-sm/6 text-muted-foreground">
            Your admin role can look at this job but not change it.
          </p>
        ) : null}
        {mayRead && domain ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
            {readsFor(detail)
              .filter((kind) => kind !== needsRead)
              .map((kind) => (
                <LiveRead key={kind} kind={kind} name={domain.name} returnTo={returnTo} />
              ))}
          </div>
        ) : null}
      </Panel>

      {needsRead && domain ? (
        <FailPrecondition
          read={needsRead}
          last={needsRead === 'registry' ? detail.registryRead : detail.transferRead}
          lastAttemptAt={detail.lastAttemptAt}
          now={now}
          name={domain.name}
          canRead={mayRead}
          returnTo={returnTo}
        />
      ) : null}

      <Panel labelledBy="job-summary-heading">
        <h2 id="job-summary-heading" className="mb-4 font-medium text-foreground">
          Summary
        </h2>
        <DlGrid items={summary} />
      </Panel>

      <Panel labelledBy="job-line-heading" className="space-y-4">
        <h2 id="job-line-heading" className="font-medium text-foreground">
          Order line and refund
        </h2>
        {line ? (
          <DlGrid
            items={[
              {
                label: 'Order',
                value: (
                  <Link href={adminHref.order(line.orderId)} className={LINK}>
                    {line.orderNumber ?? `Order ${shortId(line.orderId)}`}
                  </Link>
                ),
              },
              { label: 'Line', value: labelFor(LINE_KIND_LABEL, line.itemType) },
              {
                label: 'Price',
                value: `${formatNaira(line.priceKobo)} for ${line.periodYears} ${
                  line.periodYears === 1 ? 'year' : 'years'
                }, then ${formatNaira(line.renewalKobo)} every ${
                  line.renewalYears === 1 ? 'year' : `${line.renewalYears} years`
                }`,
              },
              {
                label: 'Line status',
                value: <AdminStatusPill value={line.status} labels={LINE_STATUS_LABEL} />,
              },
              {
                label: 'Failure code',
                value: line.failureCode ? (
                  <code className="font-mono text-sm">{line.failureCode}</code>
                ) : (
                  'None'
                ),
              },
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No order line: a customer's settings change queues a job without one.
          </p>
        )}
        {line ? (
          detail.refunds.length > 0 ? (
            <ul className="space-y-2">
              {detail.refunds.map((refund) => (
                <li
                  key={refund.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-border p-3 text-sm"
                >
                  <Link href={adminHref.refund(refund.id)} className={LINK}>
                    Refund of {formatNaira(refund.amountKobo)}
                  </Link>
                  <AdminStatusPill value={refund.status} labels={REFUND_STATUS_LABEL} />
                  <span className="text-muted-foreground">
                    {labelFor(REFUND_REASON_LABEL, refund.reason)} · {formatWat(refund.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No refund for this line.</p>
          )
        ) : null}
      </Panel>

      <Panel labelledBy="job-calls-heading" className="space-y-4">
        <h2 id="job-calls-heading" className="font-medium text-foreground">
          Supplier calls
        </h2>
        <CallTrace calls={detail.calls} empty="No supplier calls recorded for this job." />
      </Panel>

      <Panel labelledBy="job-timeline-heading" className="space-y-4">
        <h2 id="job-timeline-heading" className="font-medium text-foreground">
          Timeline
        </h2>
        <Timeline events={timeline(detail)} />
      </Panel>

      <RefreshWhile active={hasOpenJob([job])} everyMs={QUEUE_REFRESH_MS} />
    </>
  )
}
