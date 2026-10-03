import type { Metadata } from 'next'
import { Suspense } from 'react'
import { OverviewSkeleton } from '@/features/admin/components/overview/overview-skeleton'
import {
  type OverviewSearch,
  OverviewView,
} from '@/features/admin/components/overview/overview-view'
import { adminSessionStatus } from '@/features/admin/queries/session'

/**
 * The layout's "%s · Admin" template reaches child segments only, and this
 * page shares the layout's segment, so it names itself in full. A stranger
 * gets no admin title (D9), as from the layout.
 */
export async function generateMetadata(): Promise<Metadata> {
  if ((await adminSessionStatus()) === 'not_admin') return {}
  return { title: { absolute: 'Overview · Admin' } }
}

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
