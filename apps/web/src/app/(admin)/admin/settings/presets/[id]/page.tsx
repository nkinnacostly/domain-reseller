import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PresetPageView } from '@/features/admin/components/settings/preset-view'
import { SettingsPageSkeleton } from '@/features/admin/components/settings/settings-header'

export const metadata: Metadata = { title: 'Nameserver preset' }

/** One preset, its source, checks and draft (docs/ADMIN-SPEC.md §5.2 B13, D21). Routing only. */
export default function AdminSettingsPresetPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<SettingsPageSkeleton cards={3} />}>
      <PresetPageView params={params} />
    </Suspense>
  )
}
