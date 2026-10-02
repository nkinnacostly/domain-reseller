import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminPageSkeleton } from '@/features/admin/components/shell/admin-page-skeleton'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'

export const metadata: Metadata = { title: 'Nameserver presets' }

/** Package B13 builds this page (docs/ADMIN-SPEC.md §5.2, §9); until then, a placeholder. */
export default function AdminSettingsPresetsPage() {
  return (
    <Suspense fallback={<AdminPageSkeleton />}>
      <AdminPlaceholder
        title="Nameserver presets"
        description="Hosts' nameservers, their health and open drafts."
        parent={{ label: 'Settings', href: '/admin/settings' }}
      />
    </Suspense>
  )
}
