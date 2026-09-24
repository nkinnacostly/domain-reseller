import { ListChecks, Search as SearchIcon, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { Suspense } from 'react'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { toUnicodeHost } from '../lib/idn'
import { planSearch } from '../lib/plan'
import { describeProblem, displayQuery, parseSearchQuery } from '../lib/query'
import { getLengthRules } from '../queries/length-rules'
import {
  ExactSection,
  ExactSkeleton,
  GridSection,
  GridSkeleton,
  Suggestions,
  SuggestionsSkeleton,
} from './availability-sections'
import { DomainSearch } from './domain-search'

type SearchParams = Promise<{ q?: string | string[] }>

async function readQuery(searchParams: SearchParams) {
  const { q: raw } = await searchParams
  const q = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const parsed = parseSearchQuery(q)
  // What people read: `café.com` for an international name (FR-S8).
  const shown = parsed.isValid ? displayQuery(parsed) : ''
  return { q, parsed, shown }
}

/**
 * The page heading and the search box, on the blue hero. Reads `?q=` too, so
 * it has its own Suspense boundary on the page.
 */
export async function SearchHeading({ searchParams }: { searchParams: SearchParams }) {
  const { parsed, shown } = await readQuery(searchParams)

  return (
    <>
      <h1 className="text-[2.25rem] leading-[1.08] font-bold tracking-[-0.02em] break-all sm:text-5xl">
        {parsed.isValid ? (
          <>
            <span className="text-brand-muted-foreground">Results for</span> {shown}
          </>
        ) : (
          'Search for a domain'
        )}
      </h1>
      <div className="mt-8 max-w-2xl">
        <DomainSearch autoFocus={!parsed.isValid} />
      </div>
    </>
  )
}

/** FR-S5 — the way to bulk search, under the search box. Static, so it prerenders. */
export function BulkSearchLink() {
  return (
    <p className="mt-3 text-sm text-brand-muted-foreground">
      Checking a list of names?{' '}
      <Link
        href="/search/bulk"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-sm font-medium text-brand-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-foreground"
      >
        <ListChecks className="size-4" aria-hidden="true" />
        Search many at once
      </Link>
    </p>
  )
}

export function SearchHeadingSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-12 w-80 max-w-full rounded-xl bg-brand-foreground/20" />
      <div className="mt-8 h-16 max-w-2xl rounded-full bg-brand-foreground/20" />
    </div>
  )
}

/**
 * Search results (PRD E1), below the hero. Reads `?q=`, so it sits inside the
 * page's Suspense boundary. The exact match and the suggestions each stream in
 * behind their own boundary, keyed on the query, so a new search shows fresh
 * skeletons rather than the last search's answers.
 */
export async function SearchResults({ searchParams }: { searchParams: SearchParams }) {
  const { q, parsed, shown } = await readQuery(searchParams)

  if (!parsed.isValid) {
    return (
      <div className="rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-8 text-center sm:p-12">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-background text-brand-ink">
          <SearchIcon className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-4 font-semibold text-foreground">
          {parsed.problem
            ? 'That name mixes alphabets'
            : q.trim()
              ? "That doesn't look like a domain"
              : 'Type a name above to get started'}
        </p>
        <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
          {parsed.problem
            ? describeProblem(parsed.problem)
            : q.trim()
              ? 'Use letters, numbers and hyphens — for example getpaid or getpaid.com. Names in other scripts, like café.com, work too.'
              : 'Search any extension we sell, from .com to .africa.'}
        </p>
      </div>
    )
  }

  const [priced, lengthRules] = await Promise.all([getPricedCatalogue(), getLengthRules()])

  // No catalogue, no prices — and a result without a price breaks N8.
  if (!priced) {
    return (
      <div className="max-w-2xl">
        <PricingUnavailable />
      </div>
    )
  }

  const plan = planSearch({
    stem: parsed.stem,
    tld: parsed.tld,
    sold: new Set(priced.tlds.map((tld) => tld.tld)),
    featured: priced.featured.map((tld) => tld.tld),
    lengthRules,
  })
  const prices = new Map(priced.tlds.map((tld) => [tld.tld, toPublicRow(tld)]))

  return (
    <>
      {/* Three requests, three boundaries: whichever answers first shows first. */}
      {/* minmax(0, …) so a long name wraps inside its column instead of
          widening the grid past the screen. */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-10">
        {plan.unsoldTld ? (
          <div className="rounded-[2rem] border border-border bg-background p-6 sm:p-8">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              We don't sell .{toUnicodeHost(plan.unsoldTld)}
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              Here is {displayQuery({ stem: plan.stem, tld: null })} on the extensions we do sell.
              The pricing page lists every one.
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
