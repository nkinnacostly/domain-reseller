import Link from 'next/link'
import { RefreshWhile } from '@/components/common/refresh-while'
import { FOCUS, Panel, PanelHeader } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { DlGrid, type DlItem } from '@/features/admin/components/dl-grid'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { canAct } from '@/features/admin/lib/actions'
import { formatWat, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { failOffer, type JobFacts, retryOffer } from '@/features/admin/lib/jobs-copy'
import { JOB_KIND_LABEL, JOB_STATUS_LABEL, labelFor } from '@/features/admin/lib/labels'
import { hasOpenJob } from '@/features/admin/lib/queue-facts'
import type { AdminSide } from '@/features/admin/lib/side'
import type { SslJobDetail } from '@/features/admin/queries/queue'
import { cn } from '@/lib/utils'
import { JobActions } from './job-actions'
import { CallTrace, LinePanel, PlaybookCard, refundFactsFor, type Viewer } from './job-detail'
import { QUEUE_REFRESH_MS } from './jobs-list'

const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

/**
 * One certificate job (§5.2 B4). Once an order is noted as sent it is only
 * read, never failed or sent again (N3): Fail is offered only before that.
 * Its name and order line come from `admin_ssl_job_certificate` (migration
 * 42), so the dialogs name the certificate and the refund an order's Fail
 * queues. The line's refund matters to the order job only: fail_ssl_job
 * refunds an order alone, and admin_retry_ssl_job checks it for an order.
 */
export function SslJobDetailBody({
  detail,
  side,
  viewer,
}: {
  detail: SslJobDetail
  side: AdminSide
  viewer: Viewer
}) {
  const { job } = detail
  const returnTo = adminHref.sslJob(job.id)
  const kindLabel = labelFor(JOB_KIND_LABEL, job.kind)
  const money =
    job.kind === 'ssl_initialize'
      ? refundFactsFor(detail)
      : { pendingRefundKobo: null, refundAtProvider: false, failRefundKobo: null }
  const facts: JobFacts = {
    kind: job.kind,
    status: job.status,
    lastErrorCode: job.lastErrorCode,
    name: detail.name,
    ...money,
    pendingTransferLock: null,
    sentAt: job.sentAt,
  }
  const retry = retryOffer(facts)
  const fail = failOffer(facts)
  const mayRetry = canAct(viewer, 'ssl_job.retry')
  const mayFail = canAct(viewer, 'ssl_job.fail')
  const open = job.status === 'queued' || job.status === 'running'

  const summary: DlItem[] = [
    { label: 'Kind', value: kindLabel },
    { label: 'Status', value: <AdminStatusPill value={job.status} labels={JOB_STATUS_LABEL} /> },
    {
      label: 'Certificate',
      value: (
        <Link href={adminHref.certificate(job.certificateId)} className={cn(LINK, 'break-all')}>
          {detail.name ?? `Certificate ${shortId(job.certificateId)}`}
        </Link>
      ),
    },
    {
      label: 'Sent to the supplier',
      value: job.sentAt ? formatWat(job.sentAt) : 'Not sent',
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
    { label: 'Finished', value: formatWat(job.finishedAt) },
  ]
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
          { label: 'Queue', href: '/admin/queue/ssl-jobs' },
          { label: kindLabel },
        ]}
        title={
          <span className="break-all">{detail.name ?? `Certificate job ${shortId(job.id)}`}</span>
        }
        titleAside={
          <span className="inline-flex flex-wrap items-center gap-2">
            <AdminStatusPill value={job.status} labels={JOB_STATUS_LABEL} />
            {job.testMode ? <TestBadge /> : null}
          </span>
        }
        description={`${kindLabel} · job ${shortId(job.id)}`}
        actions={<SideSwitch side={side} testOnly={viewer.testOnly} />}
      />

      <Panel labelledBy="ssl-job-next-heading" className="space-y-4">
        <h2 id="ssl-job-next-heading" className="font-medium text-foreground">
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
              certificate
              retry={mayRetry && retry.offered ? retry.copy : null}
              fail={mayFail && fail.offered ? fail.copy : null}
              typeToConfirm={detail.name ?? shortId(job.id)}
              returnTo={returnTo}
            />
            {!retry.offered && retry.words ? (
              <p className="max-w-2xl text-sm/6 text-muted-foreground">{retry.words}</p>
            ) : null}
            {!fail.offered && fail.words ? (
              <p className="max-w-2xl text-sm/6 text-muted-foreground">{fail.words}</p>
            ) : null}
          </>
        ) : job.status === 'needs_attention' || job.status === 'failed' ? (
          <p className="text-sm/6 text-muted-foreground">
            Your admin role can look at this job but not change it.
          </p>
        ) : null}
      </Panel>

      <Panel labelledBy="ssl-job-summary-heading">
        <h2 id="ssl-job-summary-heading" className="mb-4 font-medium text-foreground">
          Summary
        </h2>
        <DlGrid items={summary} />
      </Panel>

      <LinePanel
        idPrefix="ssl-job"
        context={detail}
        noLine="The certificate's order line couldn't be read. Its certificate page shows the order."
      />

      <Panel labelledBy="ssl-job-others-heading" className="space-y-3">
        <h2 id="ssl-job-others-heading" className="font-medium text-foreground">
          This certificate's other jobs
        </h2>
        {detail.siblings.length > 0 ? (
          <ul className="space-y-2">
            {detail.siblings.map((sibling) => (
              <li key={sibling.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Link href={adminHref.sslJob(sibling.id)} className={LINK}>
                  {labelFor(JOB_KIND_LABEL, sibling.kind)}
                </Link>
                <AdminStatusPill value={sibling.status} labels={JOB_STATUS_LABEL} />
                <span className="text-muted-foreground">{formatWat(sibling.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </Panel>

      <Panel labelledBy="ssl-job-calls-heading" className="space-y-4">
        <h2 id="ssl-job-calls-heading" className="font-medium text-foreground">
          Supplier calls
        </h2>
        <CallTrace calls={detail.calls} empty="No supplier calls recorded for this job." />
      </Panel>

      <RefreshWhile active={hasOpenJob([job])} everyMs={QUEUE_REFRESH_MS} />
    </>
  )
}
