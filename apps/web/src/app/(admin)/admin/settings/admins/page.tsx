import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AdminsView } from '@/features/admin/components/settings/admins-view'
import { SettingsPageSkeleton } from '@/features/admin/components/settings/settings-header'

export const metadata: Metadata = { title: 'Admins' }

/** Who can open the admin area, read-only (docs/ADMIN-SPEC.md §5.2 B13, D16). Routing only. */
export default function AdminSettingsAdminsPage() {
  return (
    <Suspense fallback={<SettingsPageSkeleton />}>
      <AdminsView />
    </Suspense>
  )
}
