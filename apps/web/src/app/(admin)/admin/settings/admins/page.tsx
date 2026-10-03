import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Admins' }

/** Package B13 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminSettingsAdminsPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Admins"
        description="Who can open the admin area, and their linked devices."
        parent={{ label: 'Settings', href: '/admin/settings' }}
      />
    </Suspense>
  )
}
