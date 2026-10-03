import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AlertsSkeleton, AlertsView } from '@/features/admin/components/alerts/alerts-view'

export const metadata: Metadata = { title: 'Alerts' }

/** Alerts and health (docs/ADMIN-SPEC.md §5.2, B5). `searchParams` is read inside Suspense. */
export default function AdminAlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <Suspense fallback={<AlertsSkeleton />}>
      <AlertsView searchParams={searchParams} />
    </Suspense>
  )
}
