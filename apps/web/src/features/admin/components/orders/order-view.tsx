import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { PANEL_HEADING, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { CopyValue } from '@/features/admin/components/copy-value'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { formatWat } from '@/features/admin/lib/format'
import { labelFor, ORDER_STATUS_LABEL } from '@/features/admin/lib/labels'
import {
  ORDER_ERROR,
  ORDER_NOT_FOUND,
  ORDER_NOT_FOUND_BODY,
} from '@/features/admin/lib/orders-copy'
import { FLOAT_CHECK_LABEL } from '@/features/admin/lib/orders-format'
import type { AdminSide } from '@/features/admin/lib/side'
import { CALLS_SHOWN, getOrderDetail, type OrderDetail } from '@/features/admin/queries/orders'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import {
  OrderActivity,
  OrderIncidents,
  OrderLines,
  OrderPayments,
  OrderRefunds,
  OrderTrace,
} from './order-sections'
import { CustomerLink } from './orders-view'

const ORDERS_CRUMBS = [
  { label: 'Admin', href: '/admin' },
  { label: 'Orders', href: '/admin/orders' },
]

/** The summary card: what the order is, in one description list. */
export function OrderSummaryPanel({ detail }: { detail: OrderDetail }) {
  const { order } = detail
  return (
    <Panel labelledBy="order-summary-heading">
      <h2 id="order-summary-heading" className={PANEL_HEADING}>
        Summary
      </h2>
      <DlGrid
        className="mt-4"
        items={[
          {
            label: 'Status',
            value: <AdminStatusPill value={order.status} labels={ORDER_STATUS_LABEL} />,
          },
          { label: 'Placed', value: formatWat(order.createdAt) },
          { label: 'Paid', value: order.paidAt ? formatWat(order.paidAt) : 'Not paid' },
          {
            label: 'Customer',
            value: <CustomerLink userId={order.userId} customer={order.customer} />,
          },
          { label: 'Subtotal', value: formatNaira(order.subtotalKobo) },
          {
            label: order.vatPct === null ? 'VAT' : `VAT (${order.vatPct}%)`,
            value: formatNaira(order.vatKobo),
          },
          { label: 'Total', value: formatNaira(order.totalKobo) },
          { label: 'Invoice', value: order.invoiceNumber ?? 'Not issued' },
          { label: 'Float check', value: labelFor(FLOAT_CHECK_LABEL, order.floatCheck) },
          {
            label: 'Payment checked with Flutterwave',
            value: formatWat(order.paymentCheckedAt),
          },
          { label: 'Last change', value: formatWat(order.updatedAt) },
          {
            label: 'Nameservers for the order',
            value:
              order.nameservers && order.nameservers.length > 0
                ? order.nameservers.join(', ')
                : 'None on the order',
          },
          {
            label: 'Payment reference',
            value: order.txRef ? <CopyValue value={order.txRef} label="payment reference" /> : '—',
            wide: true,
          },
          {
            label: 'Order id',
            value: <CopyValue value={order.id} label="order id" />,
            wide: true,
          },
        ]}
      />
    </Panel>
  )
}

/** Everything on the page below its header. */
export function OrderBody({ detail }: { detail: OrderDetail }) {
  const lineNames = new Map(
    detail.lines.ok ? detail.lines.data.map((line) => [line.id, line.domain] as const) : [],
  )
  const hasCertificates =
    detail.lines.ok && detail.lines.data.some((line) => line.itemType === 'ssl')
  return (
    <>
      <OrderSummaryPanel detail={detail} />
      <OrderLines lines={detail.lines} />
      <OrderPayments payments={detail.payments} />
      <OrderRefunds refunds={detail.refunds} lines={lineNames} />
      <OrderIncidents incidents={detail.incidents} />
      <OrderTrace
        trace={detail.trace}
        lines={lineNames}
        hasCertificates={hasCertificates}
        callsShown={CALLS_SHOWN}
      />
      <OrderActivity activity={detail.activity} />
    </>
  )
}

function Header({
  admin,
  side,
  detail,
}: {
  admin: AdminPrincipal
  side: AdminSide
  detail: OrderDetail | null
}) {
  const order = detail?.order
  return (
    <PanelHeader
      crumbs={[...ORDERS_CRUMBS, { label: order?.orderNumber ?? 'Order' }]}
      title={order ? `Order ${order.orderNumber}` : 'Order'}
      titleAside={
        order ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {order.testMode ? <TestBadge /> : null}
            <AdminStatusPill value={order.status} labels={ORDER_STATUS_LABEL} />
          </span>
        ) : null
      }
      description={
        order
          ? `Placed ${formatWat(order.createdAt)} · ${formatNaira(order.totalKobo)}. Read only: an order changes through its jobs and refunds.`
          : undefined
      }
      actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
    />
  )
}

/** `/admin/orders/[id]` (B2): one order, read only. */
export async function OrderView({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const { id } = await params
  let detail: OrderDetail | null
  try {
    detail = await getOrderDetail(admin, side, id)
  } catch {
    return (
      <PanelPage>
        <Header admin={admin} side={side} detail={null} />
        <ErrorState title={ORDER_ERROR} />
      </PanelPage>
    )
  }

  return (
    <PanelPage>
      <Header admin={admin} side={side} detail={detail} />
      {detail ? (
        <OrderBody detail={detail} />
      ) : (
        <EmptyState
          title={ORDER_NOT_FOUND(side)}
          body={ORDER_NOT_FOUND_BODY}
          action={
            <Link href="/admin/orders" className={QUIET_BUTTON}>
              Back to orders
            </Link>
          }
        />
      )}
    </PanelPage>
  )
}
