import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { PANEL } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Timeline } from '@/features/admin/components/timeline'
import { formatCount, formatWat, shortId } from '@/features/admin/lib/format'
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
  callOutcomeTone,
  INCIDENT_STATE_LABEL,
  NO_ACTIVITY,
  NO_CALLS,
  NO_INCIDENTS,
  NO_JOBS,
  NO_LINES,
  NO_PAYMENTS,
  NO_REFUNDS,
  PAYMENT_STATUS_LABEL,
  paymentTone,
  SECTION_ERROR,
  SSL_TRACE_NOTE,
} from '@/features/admin/lib/orders-copy'
import {
  absorbedText,
  durationText,
  lineCostText,
  lineRenewalText,
  lineTermText,
  nairaOrUnreported,
  sentenceCase,
} from '@/features/admin/lib/orders-format'
import { ORDER_KIND_LABEL, type OrderKind } from '@/features/admin/lib/orders-params'
import type {
  DomainEvent,
  OrderIncident,
  OrderJob,
  OrderLine,
  OrderPayment,
  OrderRefund,
  Section,
  SupplierCall,
} from '@/features/admin/queries/orders'
import { cn } from '@/lib/utils'
import { When } from './when'

/**
 * The parts of one order's page (docs/ADMIN-SPEC.md §5.2, B2). Each has its
 * own heading, its own empty words, and its own error with "Try again", so
 * one failed read never hides the rest (S11). Read only: there are no
 * actions on an order (§5.2).
 */

const LINK =
  'rounded text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

const kindLabel = (value: string) => ORDER_KIND_LABEL[value as OrderKind] ?? sentenceCase(value)

/** A part of the page: a heading over its rows, or its error. */
export function OrderSection<T>({
  id,
  title,
  count,
  data,
  children,
}: {
  id: string
  title: string
  /** How many rows, read with the heading. */
  count?: (data: T) => number
  data: Section<T>
  children: (data: T) => React.ReactNode
}) {
  const heading = `order-${id}-heading`
  return (
    <section aria-labelledby={heading} className="space-y-3">
      <h2 id={heading} className="px-1 font-medium text-foreground">
        {title}
        {data.ok && count ? (
          <>
            {' '}
            <span className="text-muted-foreground">({formatCount(count(data.data))})</span>
          </>
        ) : null}
      </h2>
      {data.ok ? children(data.data) : <ErrorState title={SECTION_ERROR} />}
    </section>
  )
}

// ── Lines ──────────────────────────────────────────────────────────────────

const LINE_COLUMNS: Column<OrderLine>[] = [
  {
    key: 'domain',
    header: 'Domain',
    cell: (line) =>
      line.itemType === 'ssl' ? (
        // A certificate's line opens its certificate, found by the line (§9: ?line=).
        <Link href={adminHref.certificateForLine(line.id)} className={cn(LINK, 'break-all')}>
          {line.domain}
        </Link>
      ) : line.domainId ? (
        <Link href={adminHref.domain(line.domainId)} className={cn(LINK, 'break-all')}>
          {line.domain}
        </Link>
      ) : (
        <span className="break-all">{line.domain}</span>
      ),
  },
  { key: 'kind', header: 'Kind', cell: (line) => kindLabel(line.itemType) },
  {
    key: 'term',
    header: 'Term',
    cell: (line) => lineTermText({ item_type: line.itemType, period_years: line.periodYears }),
  },
  {
    key: 'price',
    header: 'Price',
    numeric: true,
    cell: (line) => formatNaira(line.priceKobo),
  },
  {
    key: 'renewal',
    header: 'Renewal',
    cell: (line) =>
      lineRenewalText({
        item_type: line.itemType,
        renewal_kobo: line.renewalKobo,
        renewal_years: line.renewalYears,
      }),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (line) => (
      <span className="inline-flex flex-col items-end gap-1 sm:items-start">
        <AdminStatusPill value={line.status} labels={LINE_STATUS_LABEL} />
        {line.failureCode ? (
          <code className="font-mono text-xs text-muted-foreground">{line.failureCode}</code>
        ) : null}
      </span>
    ),
  },
  { key: 'cost', header: 'Supplier cost', cell: (line) => lineCostText(line.cost) },
  {
    key: 'job',
    header: 'Job',
    cell: (line) =>
      line.itemType === 'ssl' ? (
        <Link href={adminHref.certificateForLine(line.id)} className={LINK}>
          On the certificate’s page
        </Link>
      ) : line.jobIds.length === 0 ? (
        <span className="text-muted-foreground">No job</span>
      ) : (
        <span className="inline-flex flex-wrap gap-x-3">
          {line.jobIds.map((id) => (
            <Link key={id} href={adminHref.job(id)} className={cn(LINK, 'font-mono text-sm')}>
              Job {shortId(id)}
            </Link>
          ))}
        </span>
      ),
  },
]

export function OrderLines({ lines }: { lines: Section<OrderLine[]> }) {
  return (
    <OrderSection id="lines" title="Lines" data={lines} count={(rows) => rows.length}>
      {(rows) => (
        <DataTable
          caption="What the order bought, each with its renewal price and recorded cost"
          rows={rows}
          columns={LINE_COLUMNS}
          rowKey={(line) => line.id}
          empty={<EmptyState title={NO_LINES} />}
        />
      )}
    </OrderSection>
  )
}

// ── Payments ───────────────────────────────────────────────────────────────

const PAYMENT_COLUMNS: Column<OrderPayment>[] = [
  {
    key: 'reference',
    header: 'Flutterwave reference',
    cell: (payment) => (
      <code className="font-mono text-sm break-all">{payment.providerReference ?? '—'}</code>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    numeric: true,
    cell: (payment) => nairaOrUnreported(payment.amountKobo),
  },
  {
    key: 'charged',
    header: 'Charged',
    numeric: true,
    cell: (payment) => nairaOrUnreported(payment.chargedKobo),
  },
  {
    key: 'fee',
    header: 'Fee',
    numeric: true,
    cell: (payment) => nairaOrUnreported(payment.feeKobo),
  },
  { key: 'absorbed', header: 'Fee paid by', cell: (payment) => absorbedText(payment.absorbed) },
  {
    key: 'status',
    header: 'Status',
    cell: (payment) => (
      <AdminStatusPill
        value={payment.status}
        labels={PAYMENT_STATUS_LABEL}
        tone={paymentTone(payment.status)}
      />
    ),
  },
  { key: 'method', header: 'Method', cell: (payment) => sentenceCase(payment.method) },
  { key: 'received', header: 'Received', cell: (payment) => <When at={payment.createdAt} /> },
]

export function OrderPayments({ payments }: { payments: Section<OrderPayment[]> }) {
  return (
    <OrderSection id="payments" title="Payments" data={payments} count={(rows) => rows.length}>
      {(rows) => (
        <DataTable
          caption="Charges recorded for this order, with Flutterwave's fee"
          rows={rows}
          columns={PAYMENT_COLUMNS}
          rowKey={(payment) => payment.id}
          empty={<EmptyState title={NO_PAYMENTS} />}
        />
      )}
    </OrderSection>
  )
}

// ── Refunds and incidents ──────────────────────────────────────────────────

function refundColumns(lines: Map<string, string>): Column<OrderRefund>[] {
  return [
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
      key: 'reason',
      header: 'Reason',
      cell: (refund) => labelFor(REFUND_REASON_LABEL, refund.reason),
    },
    {
      key: 'for',
      header: 'For',
      cell: (refund) =>
        refund.orderItemId ? (
          <span className="break-all">{lines.get(refund.orderItemId) ?? 'A line'}</span>
        ) : (
          'The whole charge'
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (refund) => formatNaira(refund.amountKobo),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (refund) => <AdminStatusPill value={refund.status} labels={REFUND_STATUS_LABEL} />,
    },
    { key: 'created', header: 'Opened', cell: (refund) => <When at={refund.createdAt} /> },
    { key: 'completed', header: 'Completed', cell: (refund) => <When at={refund.completedAt} /> },
    {
      key: 'error',
      header: 'Last error',
      cell: (refund) =>
        refund.lastErrorCode ? (
          <code className="font-mono text-xs">{refund.lastErrorCode}</code>
        ) : (
          '—'
        ),
    },
  ]
}

export function OrderRefunds({
  refunds,
  lines,
}: {
  refunds: Section<OrderRefund[]>
  /** Each line's domain, by line id. */
  lines: Map<string, string>
}) {
  return (
    <OrderSection id="refunds" title="Refunds" data={refunds} count={(rows) => rows.length}>
      {(rows) => (
        <DataTable
          caption="Refunds of this order's charge or lines"
          rows={rows}
          columns={refundColumns(lines)}
          rowKey={(refund) => refund.id}
          empty={<EmptyState title={NO_REFUNDS} />}
        />
      )}
    </OrderSection>
  )
}

const INCIDENT_COLUMNS: Column<OrderIncident>[] = [
  {
    key: 'incident',
    header: 'Incident',
    cell: (incident) => (
      <Link href={adminHref.incident(incident.id)} className={cn(LINK, 'font-mono text-sm')}>
        Incident {incident.id}
      </Link>
    ),
  },
  { key: 'kind', header: 'Kind', cell: (incident) => sentenceCase(incident.kind) },
  { key: 'opened', header: 'Opened', cell: (incident) => <When at={incident.createdAt} /> },
  {
    key: 'state',
    header: 'State',
    cell: (incident) => (
      <AdminStatusPill
        value={incident.resolvedAt ? 'resolved' : 'open'}
        labels={INCIDENT_STATE_LABEL}
        tone={incident.resolvedAt ? 'neutral' : 'warning'}
      />
    ),
  },
  {
    key: 'resolved',
    header: 'Closed',
    cell: (incident) =>
      incident.resolvedAt
        ? `${formatWat(incident.resolvedAt)}${incident.resolvedBy ? ` by ${incident.resolvedBy}` : ''}`
        : '—',
  },
]

export function OrderIncidents({ incidents }: { incidents: Section<OrderIncident[]> }) {
  return (
    <OrderSection
      id="incidents"
      title="Payment incidents"
      data={incidents}
      count={(rows) => rows.length}
    >
      {(rows) => (
        <DataTable
          caption="Payment incidents recorded against this order"
          rows={rows}
          columns={INCIDENT_COLUMNS}
          rowKey={(incident) => String(incident.id)}
          empty={<EmptyState title={NO_INCIDENTS} />}
        />
      )}
    </OrderSection>
  )
}

// ── The supplier trace ─────────────────────────────────────────────────────

function jobColumns(lines: Map<string, string>): Column<OrderJob>[] {
  return [
    {
      key: 'job',
      header: 'Job',
      cell: (job) => (
        <Link href={adminHref.job(job.id)} className={cn(LINK, 'font-mono text-sm')}>
          Job {shortId(job.id)}
        </Link>
      ),
    },
    { key: 'kind', header: 'Kind', cell: (job) => labelFor(JOB_KIND_LABEL, job.kind) },
    {
      key: 'for',
      header: 'For',
      cell: (job) => (
        <span className="break-all">{(job.orderItemId && lines.get(job.orderItemId)) || '—'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (job) => <AdminStatusPill value={job.status} labels={JOB_STATUS_LABEL} />,
    },
    {
      key: 'attempts',
      header: 'Attempts',
      numeric: true,
      cell: (job) => formatCount(job.attempts),
    },
    {
      key: 'error',
      header: 'Last error',
      cell: (job) =>
        job.lastErrorCode ? <code className="font-mono text-xs">{job.lastErrorCode}</code> : '—',
    },
    { key: 'started', header: 'Queued', cell: (job) => <When at={job.createdAt} /> },
    { key: 'finished', header: 'Finished', cell: (job) => <When at={job.finishedAt} /> },
  ]
}

const CALL_COLUMNS: Column<SupplierCall>[] = [
  { key: 'at', header: 'When', cell: (call) => <When at={call.createdAt} /> },
  {
    key: 'operation',
    header: 'Operation',
    cell: (call) => <code className="font-mono text-sm">{call.operation}</code>,
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
  {
    key: 'http',
    header: 'HTTP',
    numeric: true,
    cell: (call) => (call.httpStatus === null ? '—' : String(call.httpStatus)),
  },
  { key: 'duration', header: 'Took', numeric: true, cell: (call) => durationText(call.durationMs) },
  {
    key: 'code',
    header: 'Supplier code',
    cell: (call) =>
      call.errorCode ? <code className="font-mono text-xs">{call.errorCode}</code> : '—',
  },
  {
    key: 'job',
    header: 'Job',
    cell: (call) =>
      call.jobId ? (
        <Link href={adminHref.job(call.jobId)} className={cn(LINK, 'font-mono text-sm')}>
          Job {shortId(call.jobId)}
        </Link>
      ) : (
        '—'
      ),
  },
]

export function OrderTrace({
  trace,
  lines,
  hasCertificates,
  callsShown,
}: {
  trace: Section<{ jobs: OrderJob[]; calls: SupplierCall[] }>
  lines: Map<string, string>
  /** Certificate lines' jobs live on the SSL pages. */
  hasCertificates: boolean
  callsShown: number
}) {
  return (
    <OrderSection id="trace" title="Registry jobs and supplier calls" data={trace}>
      {({ jobs, calls }) => (
        <div className="space-y-3">
          {hasCertificates ? (
            <p className="px-1 text-sm text-muted-foreground">{SSL_TRACE_NOTE}</p>
          ) : null}
          <h3 className="px-1 text-sm font-medium text-foreground">
            Jobs{' '}
            <span className="font-normal text-muted-foreground">({formatCount(jobs.length)})</span>
          </h3>
          <DataTable
            caption="The registry jobs for this order's lines"
            rows={jobs}
            columns={jobColumns(lines)}
            rowKey={(job) => job.id}
            empty={<EmptyState title={NO_JOBS} />}
          />
          <h3 className="px-1 text-sm font-medium text-foreground">
            Supplier calls, newest first{' '}
            <span className="font-normal text-muted-foreground">
              ({calls.length >= callsShown ? `the latest ${callsShown}` : formatCount(calls.length)}
              )
            </span>
          </h3>
          <DataTable
            caption="Calls to DomainNameAPI made by this order's jobs, newest first"
            rows={calls}
            columns={CALL_COLUMNS}
            rowKey={(call) => String(call.id)}
            empty={<EmptyState title={NO_CALLS} />}
          />
        </div>
      )}
    </OrderSection>
  )
}

// ── Domain activity ────────────────────────────────────────────────────────

export function OrderActivity({
  activity,
}: {
  activity: Section<{ events: DomainEvent[]; domains: Map<string, string> }>
}) {
  return (
    <OrderSection
      id="activity"
      title="Domain activity since the order"
      data={activity}
      count={(data) => data.events.length}
    >
      {({ events, domains }) => (
        <div className={cn(PANEL, 'p-5 sm:p-6')}>
          <Timeline
            empty={NO_ACTIVITY}
            events={events.map((event) => ({
              id: String(event.id),
              at: event.createdAt,
              title: `${sentenceCase(event.eventType)} · ${domains.get(event.domainId) ?? 'a domain'}`,
              detail: `By ${event.actorType === 'user' ? 'the customer' : event.actorType}`,
            }))}
          />
        </div>
      )}
    </OrderSection>
  )
}
