import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DomainsSkeleton } from '@/features/admin/components/domains/domains-skeleton'
import { DomainsView } from '@/features/admin/components/domains/domains-view'

export const metadata: Metadata = { title: 'Domains' }

type Search = Promise<Record<string, string | string[] | undefined>>

/** Every domain on the side (docs/ADMIN-SPEC.md §5.2, B9). The URL holds the list. */
export default function AdminDomainsPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<DomainsSkeleton />}>
      <DomainsView searchParams={searchParams} />
    </Suspense>
  )
}
