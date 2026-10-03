import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrdersSkeleton } from '@/features/admin/components/orders/orders-skeleton'
import { OrdersView } from '@/features/admin/components/orders/orders-view'

export const metadata: Metadata = { title: 'Orders' }

type Search = Promise<Record<string, string | string[] | undefined>>

/** Every order on the side (docs/ADMIN-SPEC.md §5.2, B2). The URL holds the list. */
export default function AdminOrdersPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<OrdersSkeleton />}>
      <OrdersView searchParams={searchParams} />
    </Suspense>
  )
}
