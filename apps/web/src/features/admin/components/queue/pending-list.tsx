import Link from 'next/link'
import { FOCUS, Panel } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { ago, formatCount, formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { LINE_STATUS_LABEL, labelFor } from '@/features/admin/lib/labels'
import { LINE_KIND_LABEL } from '@/features/admin/lib/queue-facts'
import type { PendingReport, PendingRow } from '@/features/admin/queries/queue'
import { cn } from '@/lib/utils'

const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

/**
 * Paid lines with no job (§5.2 B4, "the pending-without-a-job note"). The
 * payment's own transaction queues a line's job, so a paid line without one
 * means that step did not happen: nothing was bought for it, and nothing on
 * this page can queue it.
 */
export const PENDING_NOTE =
  'A paid line gets its job in the same transaction that records the payment, so a line here means that step did not happen: nothing has been bought or refunded for it. Nothing on this page queues a job. Look at the order, then ask before acting — the fix is made in the SQL editor (DEPLOY §6).'

export function PendingTable({ report, now }: { report: PendingReport; now: Date }) {
  const columns: Column<PendingRow>[] = [
    {
      key: 'line',
      header: 'Line',
      cell: (row) => <span className="break-words">{row.domain}</span>,
    },
    {
      key: 'kind',
      header: 'Kind',
      cell: (row) => labelFor(LINE_KIND_LABEL, row.itemType),
    },
    {
      key: 'order',
      header: 'Order',
      cell: (row) => (
        <Link href={adminHref.order(row.orderId)} className={LINK}>
          {row.orderNumber ?? 'Open the order'}
        </Link>
      ),
    },
    {
      key: 'paid',
      header: 'Paid',
      cell: (row) =>
        row.paidAt ? (
          <>
            {formatWat(row.paidAt)}{' '}
            <span className="text-muted-foreground">({ago(row.paidAt, now)})</span>
          </>
        ) : (
          '—'
        ),
    },
    {
      key: 'status',
      header: 'Line status',
      cell: (row) => <AdminStatusPill value={row.status} labels={LINE_STATUS_LABEL} />,
    },
  ]
  const certificates = report.certificateLines ?? 0
  return (
    <Panel labelledBy="queue-pending-heading" className="space-y-4">
      <h2 id="queue-pending-heading" className="font-medium text-foreground">
        Paid, no job
      </h2>
      <p className="max-w-3xl text-sm/6 text-muted-foreground">{PENDING_NOTE}</p>
      {certificates > 0 ? (
        <p className="max-w-3xl text-sm/6 text-foreground">
          {formatCount(certificates)} paid certificate{' '}
          {certificates === 1 ? 'line has' : 'lines have'} no certificate record either.{' '}
          <Link href="/admin/ssl" className={LINK}>
            See Certificates
          </Link>
        </p>
      ) : null}
      <DataTable
        caption="Paid lines with no job, oldest payment first"
        rows={report.rows}
        columns={columns}
        rowKey={(row) => row.id}
        empty={
          <EmptyState
            title="Every paid domain line on this side has its job."
            body="Lines paid in the last 5 minutes are not counted yet."
          />
        }
      />
    </Panel>
  )
}
