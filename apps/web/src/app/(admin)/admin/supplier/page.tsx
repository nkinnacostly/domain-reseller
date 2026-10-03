import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SupplierPageSkeleton } from '@/features/admin/components/supplier/supplier-header'
import { SupplierView } from '@/features/admin/components/supplier/supplier-view'

export const metadata: Metadata = { title: 'Supplier' }

/** The supplier float: balance, burn, runway and top-ups (docs/ADMIN-SPEC.md §5.2 B6). Routing only. */
export default function AdminSupplierPage() {
  return (
    <Suspense fallback={<SupplierPageSkeleton cards={3} />}>
      <SupplierView />
    </Suspense>
  )
}
