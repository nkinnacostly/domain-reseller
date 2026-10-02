import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Supplier ledger' }

/** Package B6 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminSupplierLedgerPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Supplier ledger"
        description="Our mirror of DomainNameAPI's ledger, each entry matched or explained."
        parent={{ label: 'Supplier', href: '/admin/supplier' }}
      />
    </Suspense>
  )
}
