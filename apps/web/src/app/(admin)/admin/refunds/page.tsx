import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RefundsView } from '@/features/admin/components/refunds/refunds-view'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Refunds' }

/** Refunds and what waits for a person (docs/ADMIN-SPEC.md §5.2 B3). */
export default function AdminRefundsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <RefundsView searchParams={searchParams} />
    </Suspense>
  )
}
