import { formatNaira } from '@dr/shared'
import { ArrowRight, ScrollText } from 'lucide-react'
import Link from 'next/link'
import { FOCUS, PANEL_HEADING, Panel } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { ORDER_STATUS_LABEL } from '@/features/admin/lib/labels'
import type { RecentOrder } from '@/features/admin/queries/overview'
import { cn } from '@/lib/utils'

const TEXT_LINK = cn(
  'inline-flex min-h-11 items-center gap-1.5 rounded text-sm text-foreground underline underline-offset-4 hover:no-underline active:opacity-80',
  FOCUS,
)

export const NO_PAID_ORDERS = 'No paid orders on this side yet.'

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

/** Where every admin action is recorded: who did what, when, and why. */
export function AuditPointer() {
  return (
    <Panel labelledBy="overview-audit-heading" className="min-w-0">
      <div className="flex items-start gap-3">
        <ScrollText className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="overview-audit-heading" className={PANEL_HEADING}>
            Audit log
          </h2>
          <p className="mt-1 text-sm/6 text-muted-foreground">
            Every change, reveal and live look-up made in the admin area is recorded there, with who
            made it and when.
          </p>
          <Link href="/admin/audit" className={cn(TEXT_LINK, 'mt-2')}>
            Open the audit log <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </Panel>
  )
}
