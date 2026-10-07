import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { DomainPage } from '@/features/domains/components/domain-page'

export const metadata: Metadata = { title: 'Domain' }

type Params = Promise<{ id: string }>
type Query = Promise<Record<string, string | string[] | undefined>>

/** MAIL-SPEC §5: one domain — its DNS records with copy buttons, a live check, "Check now". */
export default function Page({ params, searchParams }: { params: Params; searchParams: Query }) {
  return (
    <Suspense
      fallback={
        <Container className="py-6 sm:py-8">
          <p className="sr-only" role="status">
            Loading the domain
          </p>
          <PageSkeleton />
        </Container>
      }
    >
      <DomainPage params={params} searchParams={searchParams} />
    </Suspense>
  )
}
