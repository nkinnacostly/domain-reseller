import type { Metadata } from 'next'
import { Suspense } from 'react'
import {
  type PresetsPageSearch,
  PresetsView,
} from '@/features/admin/components/settings/presets-view'
import { SettingsPageSkeleton } from '@/features/admin/components/settings/settings-header'

export const metadata: Metadata = { title: 'Nameserver presets' }

/** Hosts' nameservers, their health and open drafts (docs/ADMIN-SPEC.md §5.2 B13, D21). Routing only. */
export default function AdminSettingsPresetsPage({
  searchParams,
}: {
  searchParams: Promise<PresetsPageSearch>
}) {
  return (
    <Suspense fallback={<SettingsPageSkeleton />}>
      <PresetsView searchParams={searchParams} />
    </Suspense>
  )
}
