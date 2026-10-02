import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Price list' }

/** Package B6 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminSupplierCataloguePage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Price list"
        description="The supplier's catalogue: preview and apply, owner only."
        parent={{ label: 'Supplier', href: '/admin/supplier' }}
      />
    </Suspense>
  )
}
