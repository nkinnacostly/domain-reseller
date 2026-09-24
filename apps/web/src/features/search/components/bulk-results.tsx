import { Minus, RotateCw, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { Suspense } from 'react'
import { PricingUnavailable } from '@/features/pricing/components/pricing-unavailable'
import { type PublicPriceRow, toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import {
  BULK_MAX_NAMES,
  type BulkCheck,
  type BulkChunk,
  type BulkLine,
  type BulkPlan,
  bulkHref,
  chunkFor,
  pickDefaultTlds,
  planBulk,
  splitNames,
} from '../lib/bulk'
import { toUnicodeHost } from '../lib/idn'
import { GRID_SIZE } from '../lib/plan'
import { lengthRow, type SearchRow, toSearchRows } from '../lib/rows'
import { checkAvailability } from '../queries/availability'
import { bulkSearchAllowed } from '../queries/bulk-allowance'
import { getLengthRules } from '../queries/length-rules'
import { BulkAddAll } from './bulk-add-all'
import { BulkSearchForm } from './bulk-search-form'
import { ResultItem } from './result-list'

type BulkParams = Promise<{ names?: string | string[]; tld?: string | string[] }>

/** Far more than 20 names can take; a bound on work done for a pasted novel. */
const MAX_INPUT_CHARS = 10_000

async function readBulkParams(searchParams: BulkParams) {
  const { names, tld } = await searchParams
  const text = (Array.isArray(names) ? names.join('\n') : (names ?? '')).slice(0, MAX_INPUT_CHARS)
  const picked = tld === undefined ? [] : Array.isArray(tld) ? tld : [tld]
  return { text, picked, hasNames: splitNames(text).length > 0 }
}

/**
 * The form, on the hero. Reads the query so a person can edit their list and
 * run it again, so it sits in its own Suspense boundary on the page.
 */
export async function BulkSearchPanel({ searchParams }: { searchParams: BulkParams }) {
  const [{ text, picked }, priced] = await Promise.all([
    readBulkParams(searchParams),
    getPricedCatalogue(),
  ])
  const sold = new Set(priced?.tlds.map((tld) => tld.tld) ?? [])
  const extensions = (priced?.featured ?? [])
    .map((tld) => tld.tld)
    .filter((tld) => sold.has(tld))
    .slice(0, GRID_SIZE)

  return (
    <BulkSearchForm
      extensions={extensions}
      defaultNames={splitNames(text).join('\n')}
      defaultPicked={pickDefaultTlds(picked, sold, extensions)}
    />
  )
}

export function BulkSearchPanelSkeleton() {
  return (
    <div aria-hidden="true" className="h-96 animate-pulse rounded-3xl bg-brand-foreground/20" />
  )
}

/**
 * Bulk results (FR-S5), below the hero. Every line gets its own answer, in
 * the order typed. Lines settled here — not a name, an extension we don't
 * sell, a length the extension refuses (FR-S9) — show at once; the rest fill
 * in as each gateway request answers, each row behind its own boundary.
 */
export async function BulkResults({ searchParams }: { searchParams: BulkParams }) {
  const { text, picked, hasNames } = await readBulkParams(searchParams)
  if (!hasNames) return <BulkEmpty />

  const [priced, lengthRules] = await Promise.all([getPricedCatalogue(), getLengthRules()])
  // No catalogue, no prices — and a result without a price breaks N8.
  if (!priced) {
    return (
      <div className="max-w-2xl">
        <PricingUnavailable />
      </div>
    )
  }

  const plan = planBulk({
    text,
    picked,
    sold: new Set(priced.tlds.map((tld) => tld.tld)),
    featured: priced.featured.map((tld) => tld.tld),
    lengthRules,
  })
  // Counted only when the supplier will be asked; answers settled here are free.
  if (plan.chunks.length > 0 && !(await bulkSearchAllowed())) return <BulkLimited />

  const prices = new Map(priced.tlds.map((tld) => [tld.tld, toPublicRow(tld)]))
  const retryHref = bulkHref(splitNames(text), picked)

  return (
    <>
      <Suspense fallback={<BulkSummarySkeleton plan={plan} />}>
        <BulkSummary plan={plan} prices={prices} retryHref={retryHref} />
      </Suspense>

      <ul
        aria-label="Results, one row per name"
        className="mt-6 divide-y divide-border/70 rounded-2xl border border-border bg-background"
      >
        {plan.lines.flatMap((line, index) => lineItems(line, index, plan.chunks, prices))}
      </ul>

      {plan.skipped > 0 ? (
        <p className="mt-4 text-pretty text-sm text-muted-foreground">
          We checked the first {BULK_MAX_NAMES} names. Search the other {plan.skipped} separately.
        </p>
      ) : null}

      {/* FR-S7 — front-running protection, stated where people search. */}
      <p className="mt-12 flex max-w-2xl items-start gap-2 text-pretty text-xs/5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        We never sell or share what you search for. A search goes to our registrar only to check
        availability.
      </p>
    </>
  )
}

function lineItems(
  line: BulkLine,
  index: number,
  chunks: BulkChunk[],
  prices: ReadonlyMap<string, PublicPriceRow>,
) {
  switch (line.kind) {
    case 'invalid':
      return [
        <NoteItem
          key={`line-${index}`}
          name={line.input}
          label="Not a domain"
          note="Use letters, numbers and hyphens — for example getpaid or getpaid.com"
        />,
      ]
    case 'mixed-script':
      return [
        <NoteItem
          key={`line-${index}`}
          name={line.input}
          label="Not sold"
          // FR-S8 — refused, with the reason in plain words.
          note={`Mixes ${line.scripts.join(' and ')} letters, the way lookalike names are made`}
        />,
      ]
    case 'unsold':
      return [
        <NoteItem
          key={`line-${index}`}
          name={line.display}
          label="Not sold"
          note={`We don't sell .${toUnicodeHost(line.tld)}`}
        />,
      ]
    case 'name':
      return line.checks.map((check) =>
        check.issue ? (
          <ResultItem key={check.domain} row={lengthRow(check.name, check.tld, check.issue)} />
        ) : (
          <Suspense key={check.domain} fallback={<PendingItem check={check} />}>
            <CheckedItem check={check} chunk={chunkFor(chunks, check)} prices={prices} />
          </Suspense>
        ),
      )
  }
}

/** A row answered by the gateway. Every row in a request awaits the same, deduplicated, call. */
async function CheckedItem({
  check,
  chunk,
  prices,
}: {
  check: BulkCheck
  chunk: BulkChunk | undefined
  prices: ReadonlyMap<string, PublicPriceRow>
}) {
  return <ResultItem row={await rowFor(check, chunk, prices)} lookalike />
}

async function rowFor(
  check: BulkCheck,
  chunk: BulkChunk | undefined,
  prices: ReadonlyMap<string, PublicPriceRow>,
): Promise<SearchRow> {
  const outcome = chunk ? await checkAvailability(chunk.names, chunk.tlds) : null
  const result = outcome?.ok
    ? outcome.results.find((candidate) => candidate.domain === check.domain)
    : undefined
  const [row] = toSearchRows(
    [result ?? { name: check.name, tld: check.tld, domain: check.domain, status: 'unknown' }],
    prices,
  )
  return row as SearchRow
}

/**
 * The tally and "add all available", once every request has answered. It
 * awaits the same calls as the rows — React deduplicates them per request.
 */
async function BulkSummary({
  plan,
  prices,
  retryHref,
}: {
  plan: BulkPlan
  prices: ReadonlyMap<string, PublicPriceRow>
  retryHref: string
}) {
  const outcomes = await Promise.all(
    plan.chunks.map((chunk) => checkAvailability(chunk.names, chunk.tlds)),
  )
  const failure = outcomes.find((outcome) => !outcome.ok)
  const checks = plan.lines.flatMap((line) => (line.kind === 'name' ? line.checks : []))
  const rows = await Promise.all(
    checks.map((check) =>
      check.issue
        ? lengthRow(check.name, check.tld, check.issue)
        : rowFor(check, chunkFor(plan.chunks, check), prices),
    ),
  )
  const available = rows.filter((row) => row.status === 'available' && row.price)
  const count = (status: SearchRow['status']) => rows.filter((row) => row.status === status).length
  const refused = plan.lines.length - plan.lines.filter((line) => line.kind === 'name').length
  const tally = [
    [count('registered'), 'taken'],
    [count('premium'), 'premium'],
    [count('restricted') + refused, 'not available'],
    [count('unknown'), "couldn't be checked"],
  ] as const

  return (
    <section
      aria-labelledby="bulk-summary"
      className="rounded-3xl border border-border bg-background p-5 sm:p-6"
    >
      <h2 id="bulk-summary" className="text-xl font-bold tracking-tight text-foreground">
        {available.length === 0
          ? 'None of these are available'
          : `${available.length} of ${rows.length + refused} available`}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {tally
          .filter(([n]) => n > 0)
          .map(([n, label]) => `${n} ${label}`)
          .join(' · ') || 'Every name is free to register.'}
      </p>

      {failure && !failure.ok ? (
        <div role="status" className="mt-4 rounded-2xl border border-border border-dashed p-4">
          <p className="text-pretty text-sm/6 text-muted-foreground">
            {failure.reason === 'rate-limited'
              ? 'A lot of people are searching right now, so some names could not be checked.'
              : "We couldn't reach the registry for some names. Your list is fine — try again in a moment."}
          </p>
          <Link
            href={retryHref}
            prefetch={false}
            className="mt-3 inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            <RotateCw className="size-4" aria-hidden="true" />
            Try again
          </Link>
        </div>
      ) : null}

      {available.length > 0 ? (
        <div className="mt-5">
          <BulkAddAll domains={available.map((row) => row.domain)} />
        </div>
      ) : null}
    </section>
  )
}

function BulkSummarySkeleton({ plan }: { plan: BulkPlan }) {
  const asked = plan.chunks.reduce((sum, chunk) => sum + chunk.tlds.length, 0)
  return (
    <div className="rounded-3xl border border-border bg-background p-5 sm:p-6">
      <p role="status" className="text-sm text-muted-foreground">
        Checking {plan.lines.length} {plan.lines.length === 1 ? 'name' : 'names'}
        {asked > 0 ? ` on ${asked} ${asked === 1 ? 'extension' : 'extensions'}` : ''}…
      </p>
      <div
        aria-hidden="true"
        className="mt-3 h-11 w-64 max-w-full animate-pulse rounded-full bg-muted"
      />
    </div>
  )
}

/** A row still waiting on the registry: the name, with a placeholder for its answer. */
function PendingItem({ check }: { check: BulkCheck }) {
  return (
    <li data-status="pending" className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
      <span className="min-w-0 truncate font-medium text-muted-foreground">
        {toUnicodeHost(check.domain)}
      </span>
      <span className="sr-only">Checking</span>
      <span aria-hidden="true" className="h-5 w-20 animate-pulse rounded-full bg-muted" />
    </li>
  )
}

/** A line answered without asking anyone: what was typed, and why it wasn't checked. */
function NoteItem({ name, label, note }: { name: string; label: string; note: string }) {
  return (
    <li data-status="refused" className="px-4 py-3.5 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 truncate font-medium text-muted-foreground">{name}</span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
          <Minus className="size-3" strokeWidth={3} aria-hidden="true" />
          {label}
        </span>
      </div>
      <p className="mt-1 text-pretty text-xs text-muted-foreground">{note}</p>
    </li>
  )
}

function BulkEmpty() {
  return (
    <div className="rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-8 text-center sm:p-12">
      <p className="font-semibold text-foreground">Paste a list to check it in one go</p>
      <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
        Up to {BULK_MAX_NAMES} names, one per line. Each gets its own answer with its first-year and
        renewal price.
      </p>
    </div>
  )
}

function BulkLimited() {
  return (
    <div
      role="status"
      className="max-w-2xl rounded-2xl border border-border border-dashed p-6 sm:p-8"
    >
      <p className="font-semibold text-foreground">That's a lot of bulk searches</p>
      <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
        Bulk searches from one connection are limited to keep the registry quick for everyone. Wait
        a few minutes and try again — single searches still work meanwhile.
      </p>
    </div>
  )
}
