import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SettingsPageSkeleton } from '@/features/admin/components/settings/settings-header'
import { SslProductsView } from '@/features/admin/components/settings/ssl-products-view'

export const metadata: Metadata = { title: 'SSL products' }

/** Which certificate products are on sale (docs/ADMIN-SPEC.md §5.2 B13). Routing only. */
export default function AdminSettingsSslProductsPage() {
  return (
    <Suspense fallback={<SettingsPageSkeleton />}>
      <SslProductsView />
    </Suspense>
  )
}
