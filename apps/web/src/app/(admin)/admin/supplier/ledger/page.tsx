import type { Metadata } from 'next'
import { Suspense } from 'react'
import { type LedgerPageSearch, LedgerView } from '@/features/admin/components/supplier/ledger-view'
import { SupplierPageSkeleton } from '@/features/admin/components/supplier/supplier-header'

export const metadata: Metadata = { title: 'Supplier ledger' }

/** Our mirror of DomainNameAPI's ledger, matched or explained (docs/ADMIN-SPEC.md §5.2 B6, §7). Routing only. */
export default function AdminSupplierLedgerPage({
  searchParams,
}: {
  searchParams: Promise<LedgerPageSearch>
}) {
  return (
    <Suspense fallback={<SupplierPageSkeleton cards={3} />}>
      <LedgerView searchParams={searchParams} />
    </Suspense>
  )
}
