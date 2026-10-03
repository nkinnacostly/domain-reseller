import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DomainView } from '@/features/admin/components/domains/domain-view'
import { DomainSkeleton } from '@/features/admin/components/domains/domains-skeleton'

export const metadata: Metadata = { title: 'Domain' }

/** One domain: ours against the registry, the registrant, drift, history, jobs (§5.2 B9). */
export default function AdminDomainPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<DomainSkeleton />}>
      <DomainView params={params} />
    </Suspense>
  )
}
