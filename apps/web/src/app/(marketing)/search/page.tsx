import { Search as SearchIcon } from 'lucide-react'
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SiteFooter } from '@/components/layout/site-footer'
import { SiteHeader } from '@/components/layout/site-header'
import { Container } from '@/components/layout/site-shell'
import { DomainSearch } from '@/features/search/components/domain-search'
import { parseSearchQuery } from '@/features/search/lib/query'

export const metadata: Metadata = {
  title: 'Search results',
  robots: { index: false },
}

/**
 * Search results.
 *
 * The route exists and handles the query; the availability lookup itself is not
 * wired up yet — it runs through the registrar gateway (PRD §6.4), which needs
 * OTE credentials before any of it can be exercised safely. Until then this
 * page echoes what was searched rather than pretending to have results.
 */
/**
 * Reading `searchParams` is request-time data. Under Cache Components it must
 * sit inside a Suspense boundary, or the whole route stops prerendering and
 * every visitor waits on the server before seeing anything.
 */
async function SearchResults({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = '' } = await searchParams
  const parsed = parseSearchQuery(q)

  return (
    <>
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {parsed.isValid ? (
          <>
            Results for{' '}
            <span className="text-accent">
              {parsed.tld ? `${parsed.stem}.${parsed.tld}` : parsed.stem}
            </span>
          </>
        ) : (
          'Search for a domain'
        )}
      </h1>

      <div className="mt-6 max-w-2xl">
        <DomainSearch autoFocus={!parsed.isValid} />
      </div>

      <div className="mt-10 rounded-2xl border border-border border-dashed p-8 text-center sm:p-12">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <SearchIcon className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-4 font-semibold text-foreground">
          {parsed.isValid
            ? 'Availability checking is not connected yet'
            : 'Type a name above to get started'}
        </p>
        <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
          {parsed.isValid
            ? 'Live results arrive once the registrar gateway is wired up. Your search was understood correctly.'
            : 'Search any extension we sell, from .com to .africa.'}
        </p>
      </div>
    </>
  )
}

function SearchSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-9 w-72 rounded-lg bg-muted" />
      <div className="mt-6 h-16 max-w-2xl rounded-3xl bg-muted" />
      <div className="mt-10 h-56 rounded-2xl bg-muted/60" />
    </div>
  )
}

export default function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
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
