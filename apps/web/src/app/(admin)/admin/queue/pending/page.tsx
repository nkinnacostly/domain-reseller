import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PendingView } from '@/features/admin/components/queue/views'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'

export const metadata: Metadata = { title: 'Paid, no job' }

/** Paid lines whose job was never queued (docs/ADMIN-SPEC.md §5.2 B4). */
export default function AdminQueuePendingPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <PendingView />
    </Suspense>
  )
}
