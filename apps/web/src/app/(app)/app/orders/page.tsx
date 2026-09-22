import { formatNaira } from '@dr/shared'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { Container } from '@/components/layout/site-shell'
import { OrderStatus } from '@/features/checkout/components/order-status'
import { getOrders } from '@/features/checkout/queries/orders'

export const metadata: Metadata = { title: 'Orders' }

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeZone: 'Africa/Lagos',
})

async function Orders() {
  const orders = await getOrders()
  if (orders.length === 0) {
    return (
      <p className="rounded-3xl border border-border border-dashed px-6 py-12 text-center text-muted-foreground">
        No orders yet.
      </p>
    )
  }
  return (
    <ul
      aria-label="Your orders"
      className="divide-y divide-border/70 rounded-2xl border border-border"
    >
      {orders.map((order) => (
        <li key={order.id}>
          <Link
            href={`/app/orders/${order.id}`}
            className="flex flex-col gap-2 px-5 py-4 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="font-semibold text-foreground">
                {order.order_number}
                {order.test_mode ? (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">test</span>
                ) : null}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {order.order_items.map((item) => item.domain).join(', ')}
              </p>
            </div>
            <div className="flex items-center gap-4 sm:text-right">
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
  )
}

export default function OrdersPage() {
  return (
    <Container className="py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Orders</h1>
      <div className="mt-8">
        <Suspense
          fallback={<div aria-hidden="true" className="h-48 animate-pulse rounded-2xl bg-muted" />}
        >
          <Orders />
        </Suspense>
      </div>
    </Container>
  )
}
