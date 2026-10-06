import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { DomainsPage } from '@/features/domains/components/domains-page'

export const metadata: Metadata = { title: 'Domains' }

/** MAIL-SPEC §5, §10 Domains: each domain's state, and adding one. */
export default function Page() {
  return (
    <Suspense
      fallback={
        <Container className="py-6 sm:py-8">
          <p className="sr-only" role="status">
            Loading your domains
          </p>
          <PageSkeleton />
        </Container>
      }
    >
      <DomainsPage />
    </Suspense>
  )
}
