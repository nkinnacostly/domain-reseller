import type { Metadata } from 'next'
import { Suspense } from 'react'
import { LimitsView } from '@/features/admin/components/settings/limits-view'
import { SettingsPageSkeleton } from '@/features/admin/components/settings/settings-header'

export const metadata: Metadata = { title: 'Settings' }

/** Refund, order, velocity and float limits (docs/ADMIN-SPEC.md §5.2 B13). Routing only. */
export default function AdminSettingsPage() {
  return (
    <Suspense fallback={<SettingsPageSkeleton />}>
      <LimitsView />
    </Suspense>
  )
}
