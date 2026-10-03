import type { Metadata } from 'next'
import { Suspense } from 'react'
import { type Search, SslJobsView } from '@/features/admin/components/queue/views'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Certificate jobs' }

/** Certificate order, set-up and reissue jobs (docs/ADMIN-SPEC.md §5.2 B4). */
export default function AdminQueueSslJobsPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <SslJobsView searchParams={searchParams} />
    </Suspense>
  )
}
