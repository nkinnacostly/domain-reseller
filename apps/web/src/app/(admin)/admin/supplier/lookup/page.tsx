import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Registry lookup' }

/** Package B6 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminSupplierLookupPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Registry lookup"
        description="Read one domain, a transfer or a certificate from the supplier, audited."
        parent={{ label: 'Supplier', href: '/admin/supplier' }}
      />
    </Suspense>
  )
}
