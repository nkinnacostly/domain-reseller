import { formatNaira } from '@dr/shared'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { FOCUS, PANEL_HEADING, Panel } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { actionLabel, gatewayResult } from '@/features/admin/lib/audit-copy'
import { formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { AUDIT_OUTCOME_LABEL, ORDER_STATUS_LABEL } from '@/features/admin/lib/labels'
import type { AuditEntry } from '@/features/admin/queries/audit'
import type { RecentOrder } from '@/features/admin/queries/overview'
import { cn } from '@/lib/utils'

const TEXT_LINK = cn(
  'inline-flex min-h-11 items-center gap-1.5 rounded text-sm text-foreground underline underline-offset-4 hover:no-underline active:opacity-80',
  FOCUS,
)

export const NO_PAID_ORDERS = 'No paid orders on this side yet.'
export const NO_AUDIT_ENTRIES = 'Nothing has been recorded yet.'
export const AUDIT_NOTE =
  'Every change, reveal and live look-up made in the admin area, newest first, with who made it.'

const COLUMNS: Column<RecentOrder>[] = [
  {
    key: 'order',
    header: 'Order',
    cell: (order) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Link
          href={adminHref.order(order.id)}
          className={cn(
            'inline-flex min-h-11 items-center rounded underline-offset-4 hover:underline',
            FOCUS,
          )}
        >
          {order.orderNumber}
        </Link>
        {order.testMode ? <TestBadge /> : null}
      </span>
    ),
  },
  { key: 'paid', header: 'Paid', cell: (order) => formatWat(order.paidAt) },
  {
    key: 'total',
    header: 'Total',
    cell: (order) => formatNaira(order.totalKobo),
    numeric: true,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (order) => <AdminStatusPill value={order.status} labels={ORDER_STATUS_LABEL} />,
  },
  { key: 'invoice', header: 'Invoice', cell: (order) => order.invoiceNumber ?? '—' },
]

/**
 * The latest paid orders on this side (docs/ADMIN-SPEC.md §5.2 B1), each
 * linking to its page by id — never by a customer's name (N13).
 */
export function RecentOrders({ orders }: { orders: RecentOrder[] | null }) {
  return (
    <Panel labelledBy="overview-orders-heading" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="overview-orders-heading" className={PANEL_HEADING}>
          Latest paid orders
        </h2>
        <Link href="/admin/orders" className={TEXT_LINK}>
          Every order <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
      <div className="mt-4">
        {orders === null ? (
          <ErrorState title="The latest orders couldn't be loaded." />
        ) : (
          <DataTable
            caption="Latest paid orders"
            rows={orders}
            columns={COLUMNS}
            rowKey={(order) => order.id}
            empty={<EmptyState title={NO_PAID_ORDERS} />}
          />
        )}
      </div>
    </Panel>
  )
}

/**
 * The newest audit entries (docs/ADMIN-SPEC.md §5.2 B1): who did what and
 * how it ended, each linking to its entry in the log by number. The log's
 * own rule holds: a test administrator sees test administrators' entries
 * only. A failed read says so; the log itself is one link away.
 */
export function LatestAudit({ entries }: { entries: AuditEntry[] | null }) {
  return (
    <Panel labelledBy="overview-audit-heading" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="overview-audit-heading" className={PANEL_HEADING}>
          Audit log
        </h2>
        <Link href="/admin/audit" className={TEXT_LINK}>
          Open the audit log <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
      <p className="mt-1 text-sm/6 text-muted-foreground">{AUDIT_NOTE}</p>
      <div className="mt-4">
        {entries === null ? (
          <ErrorState title="The latest audit entries couldn't be loaded." />
        ) : entries.length === 0 ? (
          <EmptyState title={NO_AUDIT_ENTRIES} />
        ) : (
          <ol aria-label="Latest audit entries" className="divide-y divide-border">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 font-medium text-foreground">
                    {actionLabel(entry.action)}
                  </span>
                  <AdminStatusPill value={entry.outcome} labels={AUDIT_OUTCOME_LABEL} />
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {entry.adminLabel}
                    {entry.testActor ? <TestBadge /> : null}
                  </span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={entry.createdAt}>{formatWat(entry.createdAt)}</time>
                  {entry.outcome === 'intent' ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{gatewayResult(entry.result)}</span>
                    </>
                  ) : entry.errorCode ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <code className="font-mono text-xs">{entry.errorCode}</code>
                    </>
                  ) : null}
                </div>
                <Link href={adminHref.audit(entry.id)} className={cn(TEXT_LINK, 'self-start')}>
                  Entry #{entry.id}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  )
}
