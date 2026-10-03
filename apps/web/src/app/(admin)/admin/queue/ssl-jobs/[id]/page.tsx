import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SslJobView } from '@/features/admin/components/queue/views'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Certificate job' }

/** One certificate job and what the supplier said (§5.2 B4). */
export default function AdminQueueSslJobPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <SslJobView params={params} />
    </Suspense>
  )
}
