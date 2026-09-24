import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import {
  BulkResults,
  BulkSearchPanel,
  BulkSearchPanelSkeleton,
} from '@/features/search/components/bulk-results'

export const metadata: Metadata = {
  title: 'Bulk domain search',
  description: 'Check up to 20 domain names at once, each with its first-year and renewal price.',
  robots: { index: false },
}

function ResultsSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-32 rounded-3xl bg-muted/60" />
      <div className="mt-6 h-72 rounded-2xl bg-muted/60" />
    </div>
  )
}

/**
 * Bulk search (PRD FR-S5). The form and the results both read the query
 * (`?names=`, `?tld=`), so each sits in its own Suspense boundary and the
 * hero paints before either (Cache Components).
 */
export default function BulkSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ names?: string | string[]; tld?: string | string[] }>
}) {
  return (
    <>
      <SiteHeader />

      <main id="main">
        <PageHero
          title="Search many names at once"
          intro="Paste a list — each name gets its own answer, with its first-year and renewal price."
          icons={['📋', '🔍', '✅']}
        >
          <Suspense fallback={<BulkSearchPanelSkeleton />}>
            <BulkSearchPanel searchParams={searchParams} />
          </Suspense>
        </PageHero>

        <Container className="py-12 sm:py-16">
          <Suspense fallback={<ResultsSkeleton />}>
            <BulkResults searchParams={searchParams} />
          </Suspense>
        </Container>
      </main>

      <SiteFooter />
    </>
  )
}
