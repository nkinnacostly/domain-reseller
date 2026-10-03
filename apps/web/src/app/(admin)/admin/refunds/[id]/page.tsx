import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RefundView } from '@/features/admin/components/refunds/refund-view'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Refund' }

/** One refund: why it waits, its limits, its timeline and its buttons (docs/ADMIN-SPEC.md §5.2 B3). */
export default function AdminRefundPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <RefundView params={params} />
    </Suspense>
  )
}
