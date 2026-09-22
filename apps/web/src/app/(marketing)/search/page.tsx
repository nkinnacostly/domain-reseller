import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { SearchResults } from '@/features/search/components/search-results'

export const metadata: Metadata = {
  title: 'Search results',
  robots: { index: false },
}

/**
 * Reading `searchParams` is request-time data. Under Cache Components it must
 * sit inside a Suspense boundary, or the whole route stops prerendering and
 * every visitor waits on the server before seeing anything.
 */
function SearchSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-9 w-72 rounded-lg bg-muted" />
      <div className="mt-6 h-16 max-w-2xl rounded-3xl bg-muted" />
      <div className="mt-10 h-72 rounded-3xl bg-muted/60" />
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
      <SiteHeader className="border-border/60 border-b" />

      <main id="main">
        <Container className="py-10 sm:py-14">
          <Suspense fallback={<SearchSkeleton />}>
            <SearchResults searchParams={searchParams} />
          </Suspense>
        </Container>
      </main>

      <SiteFooter />
    </>
  )
}
