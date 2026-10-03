import { formatNaira, SSL_TERM } from '@dr/shared'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { CopyValue } from '@/features/admin/components/copy-value'
import { DlGrid, type DlItem } from '@/features/admin/components/dl-grid'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { canAct } from '@/features/admin/lib/actions'
import { formatCount, formatWat, formatWatDate, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import {
  JOB_KIND_LABEL,
  JOB_STATUS_LABEL,
  LINE_STATUS_LABEL,
  labelFor,
  REFUND_REASON_LABEL,
  REFUND_STATUS_LABEL,
} from '@/features/admin/lib/labels'
import {
  CALL_OUTCOME_LABEL,
  CHECK_ROLE_WORDS,
  CHECK_STATUS_INTRO,
  callOutcomeTone,
  expiryWords,
  lastReadWords,
  NO_CALLS,
  NO_JOBS,
  NO_LINE,
  NO_REFUNDS,
  NOT_ISSUED_TEXT,
  NOT_SET_UP,
  PRIVATE_KEY_NOTE,
  SECTION_ERROR,
  statusSentence,
  supplierWordText,
  unrecognisedHint,
  VALIDATION_LABEL,
  WEB_SERVER_LABEL,
} from '@/features/admin/lib/ssl-copy'
import type {
  CertificateCall,
  CertificateDetail,
  CertificateJob,
  CertificateLine,
  CertificateRecord,
  CertificateRefund,
  Section,
} from '@/features/admin/queries/ssl'
import { setupProblem } from '@/features/ssl/lib/status'
import { cn } from '@/lib/utils'
import { CheckStatus } from './check-status'
import { AccountLink, CertificatePill, LINK, Notice, When } from './ssl-parts'

/**
 * The parts of one certificate's page (docs/ADMIN-SPEC.md §5.2 B10), each in
 * its own card with its own error state (S11). Read only: a certificate
 * moves through its jobs, which the queue works.
 */

export type Viewer = { role: 'owner' | 'operator' | 'viewer'; testOnly: boolean }

function SectionCard({
  id,
  title,
  children,
  className,
}: {
  id: string
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Panel labelledBy={`certificate-${id}-heading`} className={cn('space-y-4', className)}>
      <h2 id={`certificate-${id}-heading`} className={PANEL_HEADING}>
        {title}
      </h2>
      {children}
    </Panel>
  )
}

function Code({ value }: { value: string | null | undefined }) {
  return value ? <code className="font-mono text-sm break-all">{value}</code> : <>None</>
}

/** Where it stands, what DomainNameAPI last said, and what went wrong last. */
export function StandingSection({
  certificate,
  now,
}: {
  certificate: CertificateRecord
  now: Date
}) {
  const problem = setupProblem(certificate.lastErrorCode)
  const items: DlItem[] = [
    {
      label: 'Status',
      value: (
        <CertificatePill status={certificate.status} expiresAt={certificate.expiresAt} now={now} />
      ),
    },
    {
      label: 'DomainNameAPI says',
      value: supplierWordText(certificate.supplierStatus, certificate.unrecognisedSince),
    },
    { label: 'Gateway last checked', value: formatWat(certificate.lastCheckedAt) },
    { label: 'Next check', value: formatWat(certificate.nextCheckAt) },
    {
      label: 'Last set-up problem',
      wide: true,
      value: certificate.lastErrorCode ? (
        <span className="block space-y-1">
          <Code value={certificate.lastErrorCode} />
          {problem ? (
            <span className="block text-sm text-muted-foreground">
              The customer is told: {problem}
            </span>
          ) : null}
        </span>
      ) : (
        'None'
      ),
    },
  ]
  return (
    <SectionCard id="standing" title="Where it stands">
      <p className="max-w-3xl text-sm/6 text-foreground">{statusSentence(certificate.status)}</p>
      {certificate.unrecognisedSince ? (
        <Notice>{unrecognisedHint(certificate.supplierStatus)}</Notice>
      ) : null}
      <DlGrid items={items} />
    </SectionCard>
  )
}

/** "Check status now" — a live read on a click, for a role that may (§4.3, D22). */
export function LiveStatusSection({
  certificate,
  calls,
  viewer,
  returnTo,
}: {
  certificate: CertificateRecord
  calls: Section<CertificateCall[]>
  viewer: Viewer
  returnTo: string
}) {
  const last = calls.ok
    ? (calls.data.find((call) => call.operation === 'AdminSslCheckStatus') ?? null)
    : null
  return (
    <SectionCard id="live" title="Read from DomainNameAPI">
      <p className="max-w-3xl text-sm/6 text-muted-foreground">{CHECK_STATUS_INTRO}</p>
      {calls.ok ? (
        <p className="text-sm text-foreground">
          {lastReadWords(last ? { createdAt: last.createdAt, outcome: last.outcome } : null)}
        </p>
      ) : null}
      {canAct(viewer, 'supplier.ssl_lookup') ? (
        <CheckStatus name={certificate.commonName} returnTo={returnTo} />
      ) : (
        <p className="text-sm text-muted-foreground">{CHECK_ROLE_WORDS}</p>
      )}
    </SectionCard>
  )
}

/** What it is and whose: product, names, order, customer, ids. */
export function SummarySection({
  certificate,
  line,
}: {
  certificate: CertificateRecord
  line: Section<CertificateLine | null>
}) {
  const order: React.ReactNode = !line.ok ? (
    <span className="text-muted-foreground">{SECTION_ERROR}</span>
  ) : line.data ? (
    <Link href={adminHref.order(line.data.orderId)} className={LINK}>
      {line.data.orderNumber ?? `Order ${shortId(line.data.orderId)}`}
    </Link>
  ) : (
    NO_LINE
  )
  const items: DlItem[] = [
    {
      label: 'Product',
      value: certificate.productName
        ? `${certificate.productName} (${certificate.productCode ?? '—'})`
        : (certificate.productCode ?? '—'),
    },
    { label: 'Name', value: <span className="break-all">{certificate.commonName}</span> },
    { label: 'Wildcard', value: certificate.isWildcard ? 'Yes' : 'No' },
    {
      label: 'Names included',
      value: `${formatCount(certificate.includedNames)}, the main one included`,
    },
    { label: 'Order', value: order },
    {
      label: 'Order line',
      value:
        line.ok && line.data ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <AdminStatusPill value={line.data.status} labels={LINE_STATUS_LABEL} />
            {line.data.failureCode ? <Code value={line.data.failureCode} /> : null}
          </span>
        ) : (
          '—'
        ),
    },
    { label: 'Customer', value: <AccountLink userId={certificate.userId} /> },
    { label: 'Ordered', value: formatWat(certificate.createdAt) },
    { label: 'Last change', value: formatWat(certificate.updatedAt) },
    {
      label: 'Certificate id',
      value: <CopyValue value={certificate.id} label="certificate id" />,
      wide: true,
    },
    {
      label: 'DomainNameAPI’s id',
      value: certificate.supplierCertificateId ? (
        <CopyValue value={certificate.supplierCertificateId} label="DomainNameAPI’s id" />
      ) : (
        'Not given'
      ),
      wide: true,
    },
  ]
  return (
    <SectionCard id="summary" title="Summary">
      <DlGrid items={items} />
    </SectionCard>
  )
}

/**
 * The subscription and the certificate's own dates, worded only by
 * `SSL_TERM` (CLAUDE.md §15): a one-year subscription, certificates of at
 * most 200 days, reissued free. The price shows its renewal beside it (N8).
 */
export function TermSection({
  certificate,
  line,
  now,
}: {
  certificate: CertificateRecord
  line: Section<CertificateLine | null>
  now: Date
}) {
  const paid: React.ReactNode = !line.ok ? (
    <span className="text-muted-foreground">{SECTION_ERROR}</span>
  ) : line.data ? (
    <span className="block space-y-1">
      <span className="block">{formatNaira(line.data.priceKobo)}</span>
      <span className="block text-sm text-muted-foreground">
        {SSL_TERM.renewal(formatNaira(line.data.renewalKobo))}
      </span>
    </span>
  ) : (
    '—'
  )
  const items: DlItem[] = [
    {
      label: 'Subscription',
      value: certificate.purchasedAt
        ? `${SSL_TERM.short}, bought ${formatWatDate(certificate.purchasedAt)}`
        : SSL_TERM.short,
    },
    {
      label: 'Subscription ends',
      value: certificate.subscriptionEndsAt
        ? formatWatDate(certificate.subscriptionEndsAt)
        : 'Set when it is bought',
    },
    { label: 'Certificate issued', value: formatWat(certificate.issuedAt) },
    { label: 'Certificate expires', value: expiryWords(certificate.expiresAt, now) },
    { label: 'Reissues', value: formatCount(certificate.reissueCount) },
    { label: 'Paid', value: paid },
  ]
  return (
    <SectionCard id="term" title="Term">
      <DlGrid items={items} />
      <p className="max-w-3xl text-sm/6 text-pretty text-muted-foreground">{SSL_TERM.long}</p>
    </SectionCard>
  )
}

/** The set-up as the customer sent it — the approver masked, no CSR, no contact, no key. */
export function SetupSection({ certificate }: { certificate: CertificateRecord }) {
  const sent = certificate.validationMethod !== null || certificate.webServer !== null
  const items: DlItem[] = [
    {
      label: 'Validation',
      value: certificate.validationMethod
        ? labelFor(VALIDATION_LABEL, certificate.validationMethod)
        : NOT_SET_UP,
    },
    { label: 'Approver', value: certificate.approverMasked ?? NOT_SET_UP },
    {
      label: 'Web server',
      value: certificate.webServer ? labelFor(WEB_SERVER_LABEL, certificate.webServer) : NOT_SET_UP,
    },
    {
      label: 'Set up at DomainNameAPI',
      value: certificate.configuredAt ? formatWat(certificate.configuredAt) : 'Not yet',
    },
    {
      label: 'Extra names',
      wide: true,
      value:
        certificate.sanNames.length > 0 ? (
          <ul className="space-y-1">
            {certificate.sanNames.map((name) => (
              <li key={name} className="break-all">
                {name}
              </li>
            ))}
          </ul>
        ) : (
          'None'
        ),
    },
  ]
  return (
    <SectionCard id="setup" title="Set-up">
      {sent ? null : (
        <p className="text-sm text-muted-foreground">The customer hasn’t sent the set-up yet.</p>
      )}
      <DlGrid items={items} />
      <p className="max-w-3xl text-sm/6 text-muted-foreground">{PRIVATE_KEY_NOTE}</p>
    </SectionCard>
  )
}

function Pem({ summary, text }: { summary: string; text: string }) {
  return (
    <details className="group rounded-xl border border-border bg-background">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-4 text-sm font-medium text-foreground hover:bg-muted active:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {summary}
      </summary>
      {/* PEM lines are 64 characters: wrapped, they fit a phone with no scroll box to tab to (S5, S8). */}
      <div className="relative overflow-x-auto border-border border-t">
        <pre className="p-4 font-mono text-xs/5 break-all whitespace-pre-wrap text-foreground">
          {text}
        </pre>
      </div>
    </details>
  )
}

/** The issued certificate and its chain: public text, kept so the customer can download it. */
export function CertificateTextSection({ certificate }: { certificate: CertificateRecord }) {
  return (
    <SectionCard id="text" title="Certificate text">
      {certificate.certificatePem ? (
        <div className="space-y-3">
          <Pem summary="Certificate (PEM)" text={certificate.certificatePem} />
          {certificate.caBundlePem ? (
            <Pem summary="Chain (CA bundle)" text={certificate.caBundlePem} />
          ) : (
            <p className="text-sm text-muted-foreground">No chain was stored with it.</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{NOT_ISSUED_TEXT}</p>
      )}
    </SectionCard>
  )
}

const JOB_COLUMNS: Column<CertificateJob>[] = [
  {
    key: 'kind',
    header: 'Job',
    cell: (job) => (
      <Link href={adminHref.sslJob(job.id)} className={LINK}>
        {labelFor(JOB_KIND_LABEL, job.kind)}
      </Link>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (job) => <AdminStatusPill value={job.status} labels={JOB_STATUS_LABEL} />,
  },
  { key: 'attempts', header: 'Attempts', numeric: true, cell: (job) => job.attempts },
  { key: 'error', header: 'Last error', cell: (job) => <Code value={job.lastErrorCode} /> },
  { key: 'sent', header: 'Sent', cell: (job) => <When at={job.sentAt} none="Not sent" /> },
  { key: 'made', header: 'Made', cell: (job) => <When at={job.createdAt} /> },
]

export function JobsSection({ jobs }: { jobs: Section<CertificateJob[]> }) {
  return (
    <SectionCard id="jobs" title="Jobs">
      {jobs.ok ? (
        <DataTable
          caption="This certificate's jobs, newest first"
          rows={jobs.data}
          columns={JOB_COLUMNS}
          rowKey={(job) => job.id}
          empty={<p className="text-sm text-muted-foreground">{NO_JOBS}</p>}
        />
      ) : (
        <ErrorState title={SECTION_ERROR} />
      )}
    </SectionCard>
  )
}

const REFUND_COLUMNS: Column<CertificateRefund>[] = [
  {
    key: 'refund',
    header: 'Refund',
    cell: (refund) => (
      <Link href={adminHref.refund(refund.id)} className={cn(LINK, 'font-mono text-sm')}>
        Refund {shortId(refund.id)}
      </Link>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (refund) => <AdminStatusPill value={refund.status} labels={REFUND_STATUS_LABEL} />,
  },
  {
    key: 'amount',
    header: 'Amount',
    numeric: true,
    cell: (refund) => formatNaira(refund.amountKobo),
  },
  { key: 'reason', header: 'Why', cell: (refund) => labelFor(REFUND_REASON_LABEL, refund.reason) },
  { key: 'made', header: 'Made', cell: (refund) => <When at={refund.createdAt} /> },
]

export function RefundsSection({ refunds }: { refunds: Section<CertificateRefund[]> }) {
  return (
    <SectionCard id="refunds" title="Refunds">
      {refunds.ok ? (
        <DataTable
          caption="Refunds for this certificate's line, newest first"
          rows={refunds.data}
          columns={REFUND_COLUMNS}
          rowKey={(refund) => refund.id}
          empty={<p className="text-sm text-muted-foreground">{NO_REFUNDS}</p>}
        />
      ) : (
        <ErrorState title={SECTION_ERROR} />
      )}
    </SectionCard>
  )
}

const CALL_COLUMNS: Column<CertificateCall>[] = [
  { key: 'at', header: 'When', cell: (call) => <When at={call.createdAt} /> },
  {
    key: 'operation',
    header: 'Operation',
    cell: (call) => <code className="font-mono text-xs">{call.operation}</code>,
  },
  {
    key: 'outcome',
    header: 'Outcome',
    cell: (call) => (
      <AdminStatusPill
        value={call.outcome}
        labels={CALL_OUTCOME_LABEL}
        tone={callOutcomeTone(call.outcome)}
      />
    ),
  },
  { key: 'code', header: 'Code', cell: (call) => <Code value={call.errorCode} /> },
  { key: 'http', header: 'HTTP', numeric: true, cell: (call) => call.httpStatus ?? '—' },
  {
    key: 'took',
    header: 'Took',
    numeric: true,
    cell: (call) => `${(call.durationMs / 1000).toFixed(1)} s`,
  },
  {
    key: 'job',
    header: 'Job',
    cell: (call) =>
      call.sslJobId ? (
        <Link href={adminHref.sslJob(call.sslJobId)} className={cn(LINK, 'font-mono text-sm')}>
          Job {shortId(call.sslJobId)}
        </Link>
      ) : (
        '—'
      ),
  },
]

export function CallsSection({
  calls,
  shown,
}: {
  calls: Section<CertificateCall[]>
  shown: number
}) {
  return (
    <SectionCard id="calls" title="Supplier calls">
      <p className="max-w-3xl text-sm/6 text-muted-foreground">
        Every call made about this certificate since it was ordered — by its jobs, the gateway’s
        status checks and admins — newest first, up to {shown}.
      </p>
      {calls.ok ? (
        <DataTable
          caption="Supplier calls about this certificate, newest first"
          rows={calls.data}
          columns={CALL_COLUMNS}
          rowKey={(call) => String(call.id)}
          empty={<p className="text-sm text-muted-foreground">{NO_CALLS}</p>}
        />
      ) : (
        <ErrorState title={SECTION_ERROR} />
      )}
    </SectionCard>
  )
}

/** Everything on the page below its header. */
export function CertificateBody({
  detail,
  viewer,
  now,
  callsShown,
}: {
  detail: CertificateDetail
  viewer: Viewer
  now: Date
  callsShown: number
}) {
  const { certificate } = detail
  return (
    <>
      <StandingSection certificate={certificate} now={now} />
      <LiveStatusSection
        certificate={certificate}
        calls={detail.calls}
        viewer={viewer}
        returnTo={adminHref.certificate(certificate.id)}
      />
      <SummarySection certificate={certificate} line={detail.line} />
      <TermSection certificate={certificate} line={detail.line} now={now} />
      <SetupSection certificate={certificate} />
      <CertificateTextSection certificate={certificate} />
      <JobsSection jobs={detail.jobs} />
      <RefundsSection refunds={detail.refunds} />
      <CallsSection calls={detail.calls} shown={callsShown} />
    </>
  )
}
