import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageHero } from '@/components/layout/page-hero'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import {
  SearchHeading,
  SearchHeadingSkeleton,
  SearchResults,
} from '@/features/search/components/search-results'

export const metadata: Metadata = {
  title: 'Search results',
  robots: { index: false },
}

/**
 * Reading `searchParams` is request-time data. Under Cache Components it must
 * sit inside a Suspense boundary, or the whole route stops prerendering and
 * every visitor waits on the server before seeing anything. The heading and
 * the results each get one, so the hero paints before the results arrive.
 */
function SearchSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-72 rounded-[2rem] bg-muted/60" />
    </div>
  )
}

export default function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>
}) {
  return (
    <>
      <SiteHeader />

      <main id="main">
        <PageHero icons={['🔍', '🌍', '✅']}>
          <Suspense fallback={<SearchHeadingSkeleton />}>
            <SearchHeading searchParams={searchParams} />
          </Suspense>
        </PageHero>

        <Container className="py-12 sm:py-16">
          <Suspense fallback={<SearchSkeleton />}>
            <SearchResults searchParams={searchParams} />
          </Suspense>
        </Container>
      </main>

      <SiteFooter />
    </>
  )
}
