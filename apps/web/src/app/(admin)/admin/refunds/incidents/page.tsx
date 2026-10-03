import type { Metadata } from 'next'
import { Suspense } from 'react'
import { IncidentsView } from '@/features/admin/components/refunds/incidents-view'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Payment incidents' }

/** Charges that could not be applied, until someone resolves them (docs/ADMIN-SPEC.md §5.2 B3). */
export default function AdminRefundsIncidentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <IncidentsView searchParams={searchParams} />
    </Suspense>
  )
}
