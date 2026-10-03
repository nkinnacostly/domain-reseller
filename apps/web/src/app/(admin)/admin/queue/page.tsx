import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JobsView, type Search } from '@/features/admin/components/queue/views'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Queue' }

/** Registration, renewal, transfer and settings jobs (docs/ADMIN-SPEC.md §5.2 B4). */
export default function AdminQueuePage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <JobsView searchParams={searchParams} />
    </Suspense>
  )
}
