import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'
import { WhoisForm } from '@/features/whois/components/whois-form'
import { WhoisGuide } from '@/features/whois/components/whois-guide'
import { WhoisPending } from '@/features/whois/components/whois-pending'
import { WhoisResult } from '@/features/whois/components/whois-result'

export const metadata: Metadata = pageMetadata({
  title: 'WHOIS lookup',
  description:
    'Look up any domain: whether it is registered, its registrar, when it expires, its status codes and nameservers — from the registry’s own public record.',
  path: '/whois',
})

/**
 * Public WHOIS lookup (PRD FR-PUB2, ADR-003).
 *
 * The shell prerenders; only the result reads `?domain=`, inside Suspense. Its
 * fallback reads the URL on the client, so the skeleton appears only when a
 * lookup is actually on its way — useSearchParams needs its own boundary.
 */
export default function WhoisPage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string | string[] }>
}) {
  return (
    <>
      <SiteHeader />
      <PageJsonLd trail={[{ name: 'WHOIS lookup', path: '/whois' }]} />

      <main id="main">
        <PageHero
          eyebrow="WHOIS lookup"
          title="Look up any domain"
          intro="Whether it is registered, who it is registered through, when it expires and where it points — straight from the registry’s public record."
          icons={['🔎', '🗂️', '🌐']}
        >
          <WhoisForm />
        </PageHero>

        <Suspense
          fallback={
            <Suspense fallback={null}>
              <WhoisPending />
            </Suspense>
          }
        >
          <WhoisResult searchParams={searchParams} />
        </Suspense>

        <WhoisGuide />
      </main>

      <SiteFooter />
    </>
  )
}
