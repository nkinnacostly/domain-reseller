import { formatNaira } from '@dr/shared'
import { Plus } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import {
  FOCUS,
  PANEL_HEADING,
  Panel,
  PanelHeader,
  PanelPage,
  PanelSkeleton,
  ROUND_LINK,
} from '@/components/layout/panel'
import { OrderStatus } from '@/features/checkout/components/order-status'
import { getOrders } from '@/features/checkout/queries/orders'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Orders' }

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeZone: 'Africa/Lagos',
})

async function Orders() {
  const orders = await getOrders()
  return (
    <Panel labelledBy="orders-heading">
      <h2 id="orders-heading" className={PANEL_HEADING}>
        Your orders
      </h2>
      {orders.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-border border-dashed px-6 py-12 text-center">
          <p className="text-muted-foreground">No orders yet.</p>
          <Link
            href="/search"
            className={cn(
              'mt-4 inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98]',
              FOCUS,
            )}
          >
            Search for a domain
          </Link>
        </div>
      ) : (
        <ul aria-label="Your orders" className="mt-4 space-y-2">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/app/orders/${order.id}`}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-background/80 px-5 py-4 transition-colors hover:bg-brand-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {order.order_number}
                    {order.test_mode ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">test</span>
                    ) : null}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {order.order_items.map((item) => item.domain).join(', ')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:text-right">
                  <OrderStatus status={order.status} />
                  <span className="font-medium text-foreground tabular-nums">
                    {formatNaira(Number(order.total_kobo))}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {dateFormat.format(new Date(order.created_at))}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

export default function OrdersPage() {
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Orders' },
        ]}
        title="Orders"
        description="Every order on your account, newest first. Open one to follow its registration, see its refunds or check who it was registered to."
        actions={
          <Link
            href="/search"
            aria-label="Register a new domain"
            className={cn(ROUND_LINK, 'rounded-xl', FOCUS)}
          >
            <Plus className="size-5" aria-hidden="true" />
          </Link>
        }
      />
      <Suspense fallback={<PanelSkeleton />}>
        <Orders />
      </Suspense>
    </PanelPage>
  )
}
