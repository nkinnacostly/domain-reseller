import { formatNaira } from '@dr/shared'
import { Info } from 'lucide-react'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { PANEL_HEADING, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import { formatCount, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { labelFor, ORDER_STATUS_LABEL } from '@/features/admin/lib/labels'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import {
  CAPPED_NOTICE,
  EMAIL_REFUSED,
  LIST_ERROR,
  NO_MATCH,
  NO_ORDERS,
  ORDERS_DESCRIPTION,
  STUCK_NOTE,
  sideWord,
  UNKNOWN_SEARCH,
} from '@/features/admin/lib/orders-copy'
import { FLOAT_CHECK_LABEL, orderKindsText } from '@/features/admin/lib/orders-format'
import {
  funnelRange,
  isFiltered,
  type OrderListParams,
  type OrderSort,
  ordersHref,
  parseOrderListParams,
} from '@/features/admin/lib/orders-params'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  getOrderFunnel,
  listOrders,
  type OrderList,
  type OrderListRow,
} from '@/features/admin/queries/orders'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { OrderFunnelStrip } from './order-funnel'
import { OrderSortLinks, OrderStatusChips, OrdersFilterForm, OrdersSearch } from './orders-filters'
import { When } from './when'

type Search = Record<string, string | string[] | undefined>

const LINK =
  'rounded text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** The buyer, masked (D4), linked by id — never by email (N13). */
export function CustomerLink({
  userId,
  customer,
}: {
  userId: string | null
  customer: string | null | undefined
}) {
  if (!userId) return <span className="text-muted-foreground">—</span>
  return (
    <Link href={adminHref.customer(userId)} className={LINK}>
      {customer ?? `Account ${shortId(userId)}`}
    </Link>
  )
}

/** A notice above the list: what was not done, and why. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex gap-2.5 rounded-xl border border-border bg-background/80 px-3.5 py-3 text-sm/6 text-foreground"
    >
      <Info className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 text-pretty">{children}</div>
    </div>
  )
}

export const ORDER_COLUMNS: Column<OrderListRow, OrderSort>[] = [
  {
    key: 'order',
    header: 'Order',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Link href={adminHref.order(row.id)} className={cn(LINK, 'font-medium')}>
          {row.orderNumber}
        </Link>
        {row.testMode ? <TestBadge /> : null}
      </span>
    ),
  },
  { key: 'placed', header: 'Placed', sort: 'placed', cell: (row) => <When at={row.createdAt} /> },
  {
    key: 'customer',
    header: 'Customer',
    cell: (row) => <CustomerLink userId={row.userId} customer={row.customer} />,
  },
  { key: 'kind', header: 'Kind', cell: (row) => orderKindsText(row.lines) },
  { key: 'items', header: 'Items', numeric: true, cell: (row) => formatCount(row.lines.length) },
  {
    key: 'total',
    header: 'Total',
    sort: 'total',
    numeric: true,
    className: 'whitespace-nowrap',
    cell: (row) => formatNaira(row.totalKobo),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <AdminStatusPill value={row.status} labels={ORDER_STATUS_LABEL} />,
  },
  {
    key: 'paid',
    header: 'Paid',
    sort: 'paid',
    cell: (row) => (row.paidAt ? <When at={row.paidAt} /> : 'Not paid'),
  },
  {
    key: 'invoice',
    header: 'Invoice',
    className: 'whitespace-nowrap',
    cell: (row) => row.invoiceNumber ?? '—',
  },
  {
    key: 'float',
    header: 'Float check',
    cell: (row) => labelFor(FLOAT_CHECK_LABEL, row.floatCheck),
  },
]

/** The list itself, its notices and its four states (S11). */
export function OrdersList({
  side,
  params,
  list,
}: {
  side: AdminSide
  params: OrderListParams
  list: OrderList | null
}) {
  if (params.search.kind === 'email' || params.search.kind === 'unknown') {
    return (
      <div className="space-y-3">
        <Notice>
          <p>{params.search.kind === 'email' ? EMAIL_REFUSED : UNKNOWN_SEARCH}</p>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {params.search.kind === 'email' ? (
              <Link href="/admin/customers" className={cn(LINK, 'underline')}>
                Go to Customers
              </Link>
            ) : null}
            <Link href={ordersHref(params, { q: '' })} className={cn(LINK, 'underline')}>
              Show orders without a search
            </Link>
          </p>
        </Notice>
      </div>
    )
  }
  if (!list) return <ErrorState title={LIST_ERROR} />

  const pages = pageCount(list.total, params.per)
  const notices = (
    <>
      {list.stuckNote ? <Notice>{STUCK_NOTE[list.stuckNote]}</Notice> : null}
      {list.capped ? <Notice>{CAPPED_NOTICE}</Notice> : null}
    </>
  )

  let body: React.ReactNode
  if (list.total === 0) {
    body = isFiltered(params) ? (
      <EmptyState
        title={NO_MATCH}
        body="Change or clear the filters to see more."
        action={
          <Link href="/admin/orders" className={QUIET_BUTTON}>
            Clear all filters
          </Link>
        }
      />
    ) : (
      <EmptyState
        title={NO_ORDERS(side)}
        body={
          side === 'test'
            ? 'Test orders appear here once someone pays with Flutterwave’s test keys.'
            : 'Orders appear here as customers check out.'
        }
      />
    )
  } else if (list.rows.length === 0) {
    body = (
      <EmptyState
        title={`Nothing on page ${params.page}.`}
        body={`The list has ${pages} ${pages === 1 ? 'page' : 'pages'}.`}
        action={
          <Link href={ordersHref(params, { page: 1 })} className={QUIET_BUTTON}>
            Go to the first page
          </Link>
        }
      />
    )
  } else {
    body = (
      <DataTable<OrderListRow, OrderSort>
        caption={`Orders on the ${sideWord(side)} side, page ${params.page} of ${pages}`}
        rows={list.rows}
        columns={ORDER_COLUMNS}
        rowKey={(row) => row.id}
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => ordersHref(params, nextSort(params, sort)),
        }}
        empty={null}
      />
    )
  }

  return (
    <div className="space-y-3">
      {notices}
      <OrderSortLinks params={params} />
      {body}
      {list.total > 0 ? (
        <Pager
          page={params.page}
          pageCount={pages}
          total={list.total}
          href={(page) => ordersHref(params, { page })}
        />
      ) : null}
    </div>
  )
}

/** `/admin/orders` (B2): the funnel, the filters, then the list. */
export async function OrdersView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const params = parseOrderListParams(await searchParams)
  const now = new Date()
  const range = funnelRange(params, now)
  const [list, funnel] = await Promise.all([
    listOrders(admin, side, params, now).catch(() => null),
    getOrderFunnel(side, range),
  ])

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Orders' }]}
        title="Orders"
        description={ORDERS_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      <OrderFunnelStrip funnel={funnel} range={range} />
      <Panel labelledBy="orders-find-heading" className="space-y-4">
        <h2 id="orders-find-heading" className={PANEL_HEADING}>
          Find orders
        </h2>
        <OrdersSearch params={params} />
        <OrderStatusChips params={params} />
        <OrdersFilterForm params={params} />
      </Panel>
      <section aria-labelledby="orders-list-heading" className="space-y-3">
        <h2 id="orders-list-heading" className="px-1 font-medium text-foreground">
          {list && params.search.kind !== 'email' && params.search.kind !== 'unknown'
            ? `${formatCount(list.total)} ${list.total === 1 ? 'order' : 'orders'}`
            : 'Orders'}
        </h2>
        <OrdersList side={side} params={params} list={list} />
      </section>
    </PanelPage>
  )
}
