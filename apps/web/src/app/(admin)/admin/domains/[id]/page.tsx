import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Domain' }

/** Package B9 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminDomainsDetailPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Domain"
        description="Ours against the registry, drift, history and jobs."
        parent={{ label: 'Domains', href: '/admin/domains' }}
      />
    </Suspense>
  )
}
