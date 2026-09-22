import { Search as SearchIcon, ShieldCheck } from 'lucide-react'
import { Suspense } from 'react'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { planSearch } from '../lib/plan'
import { parseSearchQuery } from '../lib/query'
import {
  ExactSection,
  ExactSkeleton,
  GridSection,
  GridSkeleton,
  Suggestions,
  SuggestionsSkeleton,
} from './availability-sections'
import { DomainSearch } from './domain-search'

/**
 * Search results (PRD E1). Reads `?q=`, so it sits inside the page's Suspense
 * boundary. The exact match and the suggestions each stream in behind their
 * own boundary, keyed on the query, so a new search shows fresh skeletons
 * rather than the last search's answers.
 */
export async function SearchResults({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>
}) {
  const { q: raw } = await searchParams
  const q = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const parsed = parseSearchQuery(q)

  if (!parsed.isValid) {
    return (
      <>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Search for a domain</h1>
        <div className="mt-6 max-w-2xl">
          <DomainSearch autoFocus />
        </div>
        <div className="mt-10 rounded-2xl border border-border border-dashed p-8 text-center sm:p-12">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
            <SearchIcon className="size-5" aria-hidden="true" />
          </span>
          <p className="mt-4 font-semibold text-foreground">
            {q.trim() ? "That doesn't look like a domain" : 'Type a name above to get started'}
          </p>
          <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
            {q.trim()
              ? 'Use letters, numbers and hyphens — for example getpaid or getpaid.com.'
              : 'Search any extension we sell, from .com to .africa.'}
          </p>
        </div>
      </>
    )
  }

  const shown = parsed.tld ? `${parsed.stem}.${parsed.tld}` : parsed.stem
  const priced = await getPricedCatalogue()

  const heading = (
    <>
      <h1 className="text-2xl font-bold tracking-tight break-all sm:text-3xl">
        Results for <span className="text-accent">{shown}</span>
      </h1>
      <div className="mt-6 max-w-2xl">
        <DomainSearch />
      </div>
    </>
  )

  // No catalogue, no prices — and a result without a price breaks N8.
  if (!priced) {
    return (
      <>
        {heading}
        <div className="mt-10 max-w-2xl">
          <PricingUnavailable />
        </div>
      </>
    )
  }

  const plan = planSearch({
    stem: parsed.stem,
    tld: parsed.tld,
    sold: new Set(priced.tlds.map((tld) => tld.tld)),
    featured: priced.featured.map((tld) => tld.tld),
  })
  const prices = new Map(priced.tlds.map((tld) => [tld.tld, toPublicRow(tld)]))

  return (
    <>
      {heading}

      <p className="mt-6 max-w-2xl rounded-xl bg-muted/60 px-4 py-3 text-pretty text-sm/6 text-muted-foreground">
        <span className="font-medium text-foreground">Checkout isn't open yet.</span> Availability
        and prices below are live.
      </p>

      {/* Three requests, three boundaries: whichever answers first shows first. */}
      <div className="mt-8 grid gap-8 lg:grid-cols-[1.15fr_1fr] lg:gap-10">
        {plan.unsoldTld ? (
          <div className="rounded-3xl border border-border bg-background p-6 sm:p-8">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              We don't sell .{plan.unsoldTld}
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              Here is {plan.stem} on the extensions we do sell. The pricing page lists every one.
            </p>
          </div>
        ) : (
          <Suspense key={`exact:${shown}`} fallback={<ExactSkeleton />}>
            <ExactSection plan={plan} prices={prices} query={shown} />
          </Suspense>
        )}
        <Suspense key={`grid:${shown}`} fallback={<GridSkeleton />}>
          <GridSection plan={plan} prices={prices} query={shown} />
        </Suspense>
      </div>

      <div className="mt-14">
        <Suspense key={`ideas:${shown}`} fallback={<SuggestionsSkeleton />}>
          <Suggestions plan={plan} prices={prices} query={shown} />
        </Suspense>
      </div>

      {/* FR-S7 — front-running protection, stated where people search. */}
      <p className="mt-12 flex max-w-2xl items-start gap-2 text-pretty text-xs/5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        We never sell or share what you search for. A search goes to our registrar only to check
        availability.
      </p>
    </>
  )
}
