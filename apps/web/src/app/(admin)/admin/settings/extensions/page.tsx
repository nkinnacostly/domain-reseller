import type { Metadata } from 'next'
import { Suspense } from 'react'
import {
  type ExtensionsPageSearch,
  ExtensionsView,
} from '@/features/admin/components/settings/extensions-view'
import { SettingsPageSkeleton } from '@/features/admin/components/settings/settings-header'

export const metadata: Metadata = { title: 'Extensions' }

/** Which extensions are paused or featured (docs/ADMIN-SPEC.md §5.2 B13). Routing only. */
export default function AdminSettingsExtensionsPage({
  searchParams,
}: {
  searchParams: Promise<ExtensionsPageSearch>
}) {
  return (
    <Suspense fallback={<SettingsPageSkeleton cards={2} />}>
      <ExtensionsView searchParams={searchParams} />
    </Suspense>
  )
}
