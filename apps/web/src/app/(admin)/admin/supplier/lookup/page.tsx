import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LookupView } from '@/features/admin/components/supplier/lookup-view'
import { SupplierPageSkeleton } from '@/features/admin/components/supplier/supplier-header'

export const metadata: Metadata = { title: 'Registry lookup' }

/** Live, audited reads of one domain, certificate or price (docs/ADMIN-SPEC.md §5.2 B6). Routing only. */
export default function AdminSupplierLookupPage() {
  return (
    <Suspense fallback={<SupplierPageSkeleton cards={4} />}>
      <LookupView />
    </Suspense>
  )
}
