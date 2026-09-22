import { RotateCw } from 'lucide-react'
import Link from 'next/link'
import type { PublicPriceRow } from '@/features/pricing/lib/public-row'
import type { SearchPlan } from '../lib/plan'
import { searchHref } from '../lib/query'
import { pickSuggestions, SUGGESTION_COUNT, toSearchRows } from '../lib/rows'
import { type AvailabilityOutcome, checkAvailability } from '../queries/availability'
import { ExactResult } from './exact-result'
import { ResultList } from './result-list'

type SectionProps = {
  plan: SearchPlan
  prices: ReadonlyMap<string, PublicPriceRow>
  /** What the person typed, for the retry link. */
  query: string
}

const FAILURE_COPY: Record<Extract<AvailabilityOutcome, { ok: false }>['reason'], string> = {
  'rate-limited': 'A lot of people are searching right now. Give it a few seconds and try again.',
  unavailable:
    "We couldn't reach the registry just now. Your search is fine — try it again in a moment.",
}

function CheckFailed({ reason, query }: { reason: keyof typeof FAILURE_COPY; query: string }) {
  return (
    <div role="status" className="rounded-2xl border border-border border-dashed p-6 sm:p-8">
      <p className="font-semibold text-foreground">Availability isn't showing right now</p>
      <p className="mt-2 max-w-xl text-pretty text-sm/6 text-muted-foreground">
        {FAILURE_COPY[reason]}
      </p>
      <Link
        href={searchHref(query)}
        prefetch={false}
        className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
      >
        <RotateCw className="size-4" aria-hidden="true" />
        Try again
      </Link>
    </div>
  )
}

/**
 * The exact match on its own request, so it lands first (~1s) instead of
 * waiting behind the grid — the gateway has only two supplier slots (PRD V4).
 */
export async function ExactSection({ plan, prices, query }: SectionProps) {
  if (!plan.exact) return null
  const outcome = await checkAvailability([plan.exact.name], [plan.exact.tld], 'high')
  if (!outcome.ok) return <CheckFailed reason={outcome.reason} query={query} />

  const [row] = toSearchRows(outcome.results, prices)
  return row ? <ExactResult row={row} /> : null
}

/** The same name on the other featured extensions (FR-S1 TLD grid). */
export async function GridSection({ plan, prices, query }: SectionProps) {
  const tlds = plan.gridTlds.filter((tld) => tld !== plan.exact?.tld)
  if (tlds.length === 0) return null

  const outcome = await checkAvailability([plan.stem], tlds)

  return (
    <section aria-labelledby="other-extensions">
      <h2 id="other-extensions" className="text-lg font-semibold text-foreground">
        {plan.stem} on other extensions
      </h2>
      <div className="mt-4">
        {outcome.ok ? (
          <ResultList
            rows={toSearchRows(outcome.results, prices)}
            label={`${plan.stem} on other extensions`}
          />
        ) : (
          <CheckFailed reason={outcome.reason} query={query} />
        )}
      </div>
    </section>
  )
}

/**
 * FR-S4 / ADR-002 — affixed alternatives, available ones only.
 *
 * Checked on the lead extension first; the second is asked only if the first
 * leaves fewer than SUGGESTION_COUNT free. Every call spends one of the
 * supplier's two slots (PRD V4), and most searches never need the second.
 */
export async function Suggestions({ plan, prices, query }: SectionProps) {
  const [first, second] = plan.suggestionTlds
  if (plan.suggestionNames.length === 0 || !first) return null

  const outcome = await checkAvailability(plan.suggestionNames, [first])
  let rows = outcome.ok ? toSearchRows(outcome.results, prices) : []

  if (second && pickSuggestions(rows, plan.suggestionTlds).length < SUGGESTION_COUNT) {
    const more = await checkAvailability(plan.suggestionNames, [second])
    if (more.ok) rows = [...rows, ...toSearchRows(more.results, prices)]
  }

  return (
    <section aria-labelledby="suggestions-heading">
      <h2 id="suggestions-heading" className="text-xl font-bold tracking-tight sm:text-2xl">
        Available alternatives
      </h2>

      {!outcome.ok ? (
        <div className="mt-4">
          <CheckFailed reason={outcome.reason} query={query} />
        </div>
      ) : (
        <SuggestionLists rows={pickSuggestions(rows, plan.suggestionTlds)} />
      )}
    </section>
  )
}

function SuggestionLists({ rows }: { rows: ReturnType<typeof pickSuggestions> }) {
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-pretty text-muted-foreground">
        None of our usual variations are free on these extensions. Try a different name.
      </p>
    )
  }

  // Two columns on wide screens; one continuous list in reading order below.
  const half = Math.ceil(rows.length / 2)
  return (
    <div className="mt-5 grid gap-4 lg:grid-cols-2">
      <ResultList rows={rows.slice(0, half)} label="Available alternatives" />
      {rows.length > half ? (
        <ResultList rows={rows.slice(half)} label="More available alternatives" />
      ) : null}
    </div>
  )
}

export function ExactSkeleton() {
  return <div aria-hidden="true" className="h-72 animate-pulse rounded-3xl bg-muted" />
}

export function GridSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-6 w-56 rounded bg-muted" />
      <div className="mt-4 h-[18rem] rounded-2xl bg-muted/70" />
    </div>
  )
}

export function SuggestionsSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse">
      <div className="h-8 w-64 rounded bg-muted" />
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="h-72 rounded-2xl bg-muted/70" />
        <div className="h-72 rounded-2xl bg-muted/70" />
      </div>
    </div>
  )
}
