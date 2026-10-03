import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Supplier' }

/** Package B6 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminSupplierPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Supplier"
        description="DomainNameAPI's balance, burn and runway, and our top-ups."
      />
    </Suspense>
  )
}
