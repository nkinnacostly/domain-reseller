import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Certificate job' }

/** Package B4 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminQueueSslJobsDetailPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Certificate job"
        description="One certificate job and what the supplier said."
        parent={{ label: 'Queue', href: '/admin/queue' }}
      />
    </Suspense>
  )
}
