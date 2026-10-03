import type { Metadata } from 'next'
import { Suspense } from 'react'
import { JobView } from '@/features/admin/components/queue/views'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Job' }

/** One job: the playbook, Retry and Fail, its line and refund, its supplier calls (§5.2 B4). */
export default function AdminQueueJobPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <JobView params={params} />
    </Suspense>
  )
}
