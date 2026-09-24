import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { BulkResults } from '@/features/search/components/bulk-results'
import { BulkRunProvider } from '@/features/search/components/bulk-run'
import {
  BulkSearchPanel,
  BulkSearchPanelSkeleton,
} from '@/features/search/components/bulk-search-panel'
import { PageJsonLd } from '@/features/seo/components/breadcrumb-json-ld'
import { pageMetadata } from '@/features/seo/lib/metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Bulk domain search',
  description:
    'Check up to 500 domain names at once, pasted or from a CSV file, each with its first-year and renewal price.',
  path: '/search/bulk',
})

/**
 * Bulk search (PRD FR-S5). The form reads the query (`?names=`, `?tld=`), so
 * it sits in a Suspense boundary and the hero paints first (Cache
 * Components). The list is checked from the page, block by block, and the
 * results below fill in as each block answers — both share one run.
 */
export default function BulkSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ names?: string | string[]; tld?: string | string[] }>
}) {
  return (
    <>
      <SiteHeader />
      <PageJsonLd trail={[{ name: 'Bulk domain search', path: '/search/bulk' }]} />

      <main id="main">
        <BulkRunProvider>
          <PageHero
            title="Search many names at once"
            intro="Paste a list or upload a CSV — each name gets its own answer, with its first-year and renewal price."
            icons={['📋', '🔍', '✅']}
          >
            <Suspense fallback={<BulkSearchPanelSkeleton />}>
              <BulkSearchPanel searchParams={searchParams} />
            </Suspense>
          </PageHero>

          <Container className="py-12 sm:py-16">
            <BulkResults />
          </Container>
        </BulkRunProvider>
      </main>

      <SiteFooter />
    </>
  )
}
