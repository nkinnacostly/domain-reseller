import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CatalogueView } from '@/features/admin/components/supplier/catalogue-view'
import { SupplierPageSkeleton } from '@/features/admin/components/supplier/supplier-header'

export const metadata: Metadata = { title: 'Price list' }

/** The supplier's catalogue: preview and apply, owner only (docs/ADMIN-SPEC.md §5.2 B6, D19). Routing only. */
export default function AdminSupplierCataloguePage() {
  return (
    <Suspense fallback={<SupplierPageSkeleton cards={2} />}>
      <CatalogueView />
    </Suspense>
  )
}
