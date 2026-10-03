import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OrderView } from '@/features/admin/components/orders/order-view'
import { OrderSkeleton } from '@/features/admin/components/orders/orders-skeleton'

export const metadata: Metadata = { title: 'Order' }

/** One order, read only (docs/ADMIN-SPEC.md §5.2, B2). */
export default function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<OrderSkeleton />}>
      <OrderView params={params} />
    </Suspense>
  )
}
