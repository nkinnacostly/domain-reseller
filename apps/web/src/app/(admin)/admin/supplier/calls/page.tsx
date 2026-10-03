import type { Metadata } from 'next'
import { Suspense } from 'react'
import { type CallsPageSearch, CallsView } from '@/features/admin/components/supplier/calls-view'
import { SupplierPageSkeleton } from '@/features/admin/components/supplier/supplier-header'

export const metadata: Metadata = { title: 'Supplier calls' }

/** Every provisioning call the gateway recorded (docs/ADMIN-SPEC.md §5.2 B6). Routing only. */
export default function AdminSupplierCallsPage({
  searchParams,
}: {
  searchParams: Promise<CallsPageSearch>
}) {
  return (
    <Suspense fallback={<SupplierPageSkeleton cards={2} />}>
      <CallsView searchParams={searchParams} />
    </Suspense>
  )
}
