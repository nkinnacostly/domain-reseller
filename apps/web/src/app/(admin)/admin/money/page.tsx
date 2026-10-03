import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Money' }

/** Package B7 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminMoneyPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Money"
        description="Sales, VAT, refunds, fees and margin by day, week or month."
      />
    </Suspense>
  )
}
