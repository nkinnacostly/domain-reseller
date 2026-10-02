import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Payment incidents' }

/** Package B3 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminRefundsIncidentsPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Payment incidents"
        description="Charges that did not match an order, until someone resolves them."
        parent={{ label: 'Refunds', href: '/admin/refunds' }}
      />
    </Suspense>
  )
}
