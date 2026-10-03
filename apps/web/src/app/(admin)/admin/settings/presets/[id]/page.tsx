import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Nameserver preset' }

/** Package B13 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminSettingsPresetsDetailPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Nameserver preset"
        description="One preset, its source, checks and draft."
        parent={{ label: 'Nameserver presets', href: '/admin/settings/presets' }}
      />
    </Suspense>
  )
}
