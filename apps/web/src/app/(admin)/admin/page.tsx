import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OverviewSkeleton } from '@/features/admin/components/overview/overview-skeleton'
import {
  type OverviewSearch,
  OverviewView,
} from '@/features/admin/components/overview/overview-view'

export const metadata: Metadata = { title: 'Overview' }

/** Operations at a glance (docs/ADMIN-SPEC.md §5.2 B1). Routing only. */
export default function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<OverviewSearch>
}) {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewView searchParams={searchParams} />
    </Suspense>
  )
}
