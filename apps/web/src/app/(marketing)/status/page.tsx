import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { ServiceStatus, ServiceStatusSkeleton } from '@/features/status/components/service-status'
import { BUSINESS } from '@/lib/business'

export const metadata: Metadata = pageMetadata({
  title: 'Service status',
  description:
    'Whether registrations, renewals, nameserver changes and registry checks are running right now, read live on every visit.',
  path: '/status',
})

/**
 * Service status. The hero and the notes prerender; the status itself is read
 * on every visit (never cached), so it streams in behind Suspense.
 */
export default function StatusPage() {
  return (
    <>
      <SiteHeader />
      <PageJsonLd trail={[{ name: 'Service status', path: '/status' }]} />

      <main id="main">
        <PageHero
          eyebrow="Service status"
          title="Is everything working?"
          intro="How the parts that act on your domains are doing right now. This page reads them live every time you open it."
          icons={['🟢', '⏱️', '🛠️']}
        />

        <Container className="py-12 sm:py-16">
          <Suspense fallback={<ServiceStatusSkeleton />}>
            <ServiceStatus />
          </Suspense>
        </Container>

        <Container className="pb-16 sm:pb-24">
          <section
            aria-labelledby="status-scope-heading"
            className="max-w-2xl rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-7 sm:p-10"
          >
            <h2 id="status-scope-heading" className="text-xl font-bold tracking-tight sm:text-2xl">
              What this page can&apos;t see
            </h2>
            <p className="mt-3 text-pretty text-sm/6 text-muted-foreground">
              It shows what our own systems record about themselves. It does not test searching,
              signing in or paying. If one of those is not working for you, email{' '}
              <a
                href={`mailto:${BUSINESS.email}`}
                className="rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {BUSINESS.email}
              </a>{' '}
              or see the{' '}
              <Link
                href="/help"
                className="rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                help centre
              </Link>
              .
            </p>
          </section>
        </Container>
      </main>

      <SiteFooter />
    </>
  )
}
