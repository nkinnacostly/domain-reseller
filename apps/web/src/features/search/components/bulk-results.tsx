'use client'

import { Check, CircleHelp, Download, Minus, RotateCw, ShieldCheck, Square, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { renewalText, yearsText } from '@/features/pricing/lib/terms'
import { cn } from '@/lib/utils'
import { BULK_MAX_NAMES } from '../lib/bulk'
import {
  type BulkRun,
  type BulkTally,
  type FailReason,
  FILTERS,
  failureReason,
  filterRows,
  isSelectable,
  progress,
  type ResultRow,
  type RowFilter,
  type RowSort,
  resultRows,
  sortRows,
  tally,
  uncheckedDomains,
} from '../lib/bulk-run'
import { joinWords, resultsCsv } from '../lib/csv'
import { BulkAddSelected } from './bulk-add-selected'
import { useBulkRun } from './bulk-run'
import { AsciiForm, LookalikeWarning } from './idn-notes'
import { ResultStatus } from './result-status'

/** Rows drawn at a time: 500 names on seven extensions is 3,500 rows, too many for a phone at once. */
const PAGE_SIZE = 100

const count = (n: number) => n.toLocaleString('en-NG')
const names = (n: number) => `${count(n)} ${n === 1 ? 'name' : 'names'}`

/**
 * Bulk results (FR-S5), below the hero: a summary with progress, filters and
 * order, "select all available" and the cart, a CSV download, then one row
 * per name and extension — filled in as each block of the list is answered.
 */
export function BulkResults() {
  const { run, retry, stop } = useBulkRun()
  return (
    <>
      {run ? <BulkResultsView key={run.id} run={run} retry={retry} stop={stop} /> : <BulkEmpty />}

      {/* FR-S7 — front-running protection, stated where people search. */}
      <p className="mt-12 flex max-w-2xl items-start gap-2 text-pretty text-xs/5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        We never sell or share what you search for. A search goes to our registrar only to check
        availability, and a CSV file you upload is read on your device — only the names in it are
        sent, to be checked.
      </p>
    </>
  )
}

function BulkResultsView({
  run,
  retry,
  stop,
}: {
  run: BulkRun
  retry: () => void
  stop: () => void
}) {
  const rows = useMemo(() => resultRows(run), [run])
  const counts = useMemo(() => tally(rows), [rows])
  const [filter, setFilter] = useState<RowFilter>('all')
  const [sort, setSort] = useState<RowSort>('list')
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [limit, setLimit] = useState(PAGE_SIZE)

  const visible = useMemo(() => sortRows(filterRows(rows, filter), sort), [rows, filter, sort])
  const selectable = useMemo(() => rows.filter(isSelectable), [rows])
  const chosen = useMemo(
    () =>
      sortRows(selectable, sort)
        .map((row) => row.domain as string)
        .filter((domain) => selected.has(domain)),
    [selectable, sort, selected],
  )
  const allSelected = selectable.length > 0 && chosen.length === selectable.length

  const toggle = useCallback((domain: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }, [])

  // The answer names what went in as people read it; untick those.
  const untickAdded = useCallback(
    (added: readonly string[]) => {
      const shown = new Set(added)
      const displayOf = new Map(rows.map((row) => [row.domain, row.display]))
      setSelected(
        (previous) =>
          new Set([...previous].filter((domain) => !shown.has(displayOf.get(domain) ?? ''))),
      )
    },
    [rows],
  )

  function choose(next: RowFilter) {
    setFilter(next)
    setLimit(PAGE_SIZE)
  }

  function download() {
    const blob = new Blob([resultsCsv(visible)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bulk-search-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.append(link)
    link.click()
    link.remove()
    // After the click has been handled, so the download has what it needs.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  return (
    <>
      <BulkSummary run={run} counts={counts} rows={rows.length} stop={stop} />

      {!run.running && counts.unchecked > 0 ? (
        <UncheckedNotice
          run={run}
          unchecked={counts.unchecked}
          retry={retry}
          show={() => choose('unchecked')}
        />
      ) : null}

      <div className="mt-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <fieldset>
          <legend className="text-sm font-medium text-foreground">Show</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {FILTERS.map((option) => (
              <label
                key={option}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-sm font-medium transition hover:bg-muted active:scale-[0.98] has-checked:border-accent/50 has-checked:bg-accent/10 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
              >
                {/* A real radio, like the extension chips: not colour alone (S8). */}
                <input
                  type="radio"
                  name="bulk-filter"
                  value={option}
                  checked={filter === option}
                  onChange={() => choose(option)}
                  className="size-4 accent-accent"
                />
                {FILTER_LABEL[option]}
                <span className="text-muted-foreground tabular-nums">
                  {count(filterCount(option, counts, rows.length))}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-foreground">
            Order
            <select
              value={sort}
              onChange={(event) => setSort(event.currentTarget.value as RowSort)}
              className="mt-2 block h-11 rounded-full border border-input bg-background px-4 text-sm text-foreground outline-none transition hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <option value="list">As listed</option>
              <option value="name">Name, A to Z</option>
              <option value="price">Price, lowest first</option>
            </select>
          </label>
          <button
            type="button"
            onClick={download}
            disabled={run.running || visible.length === 0}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Download className="size-4" aria-hidden="true" />
            Download {count(visible.length)} as CSV
          </button>
        </div>
      </div>

      {selectable.length > 0 ? (
        <section
          aria-label="Add to cart"
          className="mt-4 flex flex-col gap-4 rounded-2xl border border-border bg-muted/40 p-4 sm:p-5 lg:flex-row lg:items-start lg:justify-between"
        >
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() =>
                setSelected(
                  allSelected ? new Set() : new Set(selectable.map((row) => row.domain as string)),
                )
              }
              className="inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              {allSelected ? (
                <X className="size-4" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )}
              {allSelected ? 'Clear selection' : `Select all ${count(selectable.length)} available`}
            </button>
            <p className="text-sm text-muted-foreground tabular-nums">
              {count(chosen.length)} selected
            </p>
          </div>
          <BulkAddSelected domains={chosen} onAdded={untickAdded} />
        </section>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-border border-dashed p-6 text-center text-sm text-muted-foreground">
          {EMPTY_FILTER[filter]}
        </p>
      ) : (
        <ul
          aria-label="Results, one row per name"
          className="mt-6 divide-y divide-border/70 rounded-2xl border border-border bg-background"
        >
          {visible.slice(0, limit).map((row) => (
            <BulkRow
              key={row.key}
              row={row}
              selected={row.domain !== null && selected.has(row.domain)}
              toggle={toggle}
            />
          ))}
        </ul>
      )}

      {visible.length > limit ? (
        <button
          type="button"
          onClick={() => setLimit((current) => current + PAGE_SIZE)}
          className="mt-4 inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          Show {count(Math.min(PAGE_SIZE, visible.length - limit))} more of{' '}
          {count(visible.length - limit)} not shown
        </button>
      ) : null}
    </>
  )
}

const FILTER_LABEL: Record<RowFilter, string> = {
  all: 'All',
  available: 'Available',
  taken: 'Taken',
  premium: 'Premium',
  unchecked: 'Not checked',
}

const EMPTY_FILTER: Record<RowFilter, string> = {
  all: 'Nothing to show yet.',
  available: 'None of these are available — try other extensions, or other names.',
  taken: 'None of these are taken.',
  premium: 'None of these are premium names.',
  unchecked: 'Every name has been checked.',
}

function filterCount(filter: RowFilter, counts: BulkTally, total: number): number {
  return filter === 'all' ? total : counts[filter]
}

function BulkSummary({
  run,
  counts,
  rows,
  stop,
}: {
  run: BulkRun
  counts: BulkTally
  rows: number
  stop: () => void
}) {
  const { total, checked, settled } = progress(run)
  const answered = counts.available + counts.taken + counts.premium + counts.refused
  const heading = run.running
    ? `Checking ${names(total)}…`
    : counts.available > 0
      ? `${count(counts.available)} of ${count(rows)} available`
      : counts.unchecked === 0
        ? 'None of these are available'
        : answered === 0
          ? "We couldn't check these names"
          : 'None of the names checked are available'
  const parts = [
    [counts.available, 'available'],
    [counts.taken, 'taken'],
    [counts.premium, 'premium'],
    [counts.refused, 'not available'],
    [counts.unchecked, 'not checked'],
    [counts.pending, 'still checking'],
  ] as const

  return (
    <section
      aria-labelledby="bulk-summary"
      className="rounded-3xl border border-border bg-background p-5 sm:p-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="bulk-summary" className="text-xl font-bold tracking-tight text-foreground">
            {heading}
          </h2>
          <p role="status" className="mt-1 text-sm text-foreground tabular-nums">
            {count(checked)} of {names(total)} checked
          </p>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">
            {parts
              .filter(([n]) => n > 0)
              .map(([n, label]) => `${count(n)} ${label}`)
              .join(' · ')}
          </p>
        </div>
        {run.running ? (
          <button
            type="button"
            onClick={stop}
            className="inline-flex h-11 w-fit shrink-0 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            <Square className="size-4" aria-hidden="true" />
            Stop checking
          </button>
        ) : null}
      </div>

      {run.running ? (
        <div
          role="progressbar"
          aria-label="Names checked"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={settled}
          aria-valuetext={`${count(checked)} of ${names(total)} checked`}
          className="mt-4 h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${total === 0 ? 100 : Math.round((settled / total) * 100)}%` }}
          />
        </div>
      ) : null}
    </section>
  )
}

/** Why, in words for one name or for many. */
function whyUnchecked(reason: FailReason, one: boolean): string {
  const them = one ? 'it' : 'them'
  switch (reason) {
    case 'limited':
      return `This connection has checked a lot of names in the last few minutes, so we stopped there to keep the registry quick for everyone. Wait a few minutes, then check ${them} again — single searches still work meanwhile.`
    case 'unconfirmed':
      return `You passed the check, but the next request didn’t carry its pass — your browser may be blocking cookies for this site, or your connection changed. Check ${them} again to take the check once more.`
    case 'busy':
      return `A lot of bulk searches are running right now. Your list is fine — check ${them} again in a moment.`
    case 'unavailable':
      return `The registry didn't answer for ${them} this time. Your list is fine — check ${them} again in a moment.`
    case 'stopped':
      return `You stopped the search before ${one ? 'it was' : 'they were'} checked.`
  }
}

/** Which names were not checked, why, and a way to check just those again. */
function UncheckedNotice({
  run,
  unchecked,
  retry,
  show,
}: {
  run: BulkRun
  unchecked: number
  retry: () => void
  show: () => void
}) {
  const reason = failureReason(run) ?? 'unavailable'
  const domains = uncheckedDomains(run)
  const listed = domains.slice(0, 3)
  const more = domains.length - listed.length

  return (
    <section
      aria-labelledby="bulk-unchecked"
      className="mt-4 rounded-2xl border border-border border-dashed bg-background p-4 sm:p-5"
    >
      <h3 id="bulk-unchecked" className="font-semibold text-foreground">
        {unchecked === 1 ? '1 name wasn’t checked' : `${count(unchecked)} names weren’t checked`}
      </h3>
      <p className="mt-1 text-pretty text-sm/6 text-muted-foreground">
        {whyUnchecked(reason, unchecked === 1)}
      </p>
      <p className="mt-2 text-sm break-all text-foreground">
        {joinWords(more > 0 ? [...listed, `${count(more)} more`] : listed)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={retry}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          <RotateCw className="size-4" aria-hidden="true" />
          {unchecked === 1 ? 'Check it again' : `Check these ${count(unchecked)} again`}
        </button>
        <button
          type="button"
          onClick={show}
          className="inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          Show only these
        </button>
      </div>
    </section>
  )
}

/**
 * One row. An available, priced name has a tick box — never ticked for
 * anyone (N9) — and both its prices (N8). An international name shows its
 * ASCII form (FR-S8), and a refusal says why when there is a reason to give.
 */
function BulkRow({
  row,
  selected,
  toggle,
}: {
  row: ResultRow
  selected: boolean
  toggle: (domain: string) => void
}) {
  const selectable = isSelectable(row)
  return (
    <li data-status={row.category} className="flex items-start gap-1 px-2 py-1.5 sm:gap-2 sm:px-3">
      <div className="flex size-11 shrink-0 items-center justify-center">
        {selectable ? (
          <label className="flex size-11 cursor-pointer items-center justify-center rounded-xl transition hover:bg-muted has-focus-visible:outline-2 has-focus-visible:outline-offset-[-2px] has-focus-visible:outline-ring">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => toggle(row.domain)}
              className="size-5 cursor-pointer accent-accent"
            />
            <span className="sr-only">Select {row.display}</span>
          </label>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-2.5 pr-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className={cn(
                'min-w-0 max-w-full truncate',
                row.category === 'available'
                  ? 'font-semibold text-foreground'
                  : 'font-medium text-muted-foreground',
              )}
            >
              {row.display}
            </span>
            <RowBadge row={row} />
          </div>
          {row.domain ? (
            <AsciiForm domain={row.domain} display={row.display} className="mt-0.5 block" />
          ) : null}
          {row.note ? (
            <p className="mt-1 text-pretty text-xs text-muted-foreground">{row.note}</p>
          ) : null}
          {row.name ? <LookalikeWarning stem={row.name} compact className="mt-1.5" /> : null}
        </div>

        {row.category === 'available' && row.price ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm sm:justify-end sm:text-right">
            <span className="text-base font-semibold text-foreground tabular-nums">
              {row.price.register}
            </span>
            {row.price.registerYears > 1 ? (
              <span className="text-muted-foreground">
                for {yearsText(row.price.registerYears)}
              </span>
            ) : null}
            <span className="text-muted-foreground">
              then{' '}
              <span
                className={row.price.renewalIsHigher ? 'font-medium text-foreground' : undefined}
              >
                {renewalText(row.price.renew, row.price.renewYears)}
              </span>
            </span>
          </p>
        ) : null}
      </div>
    </li>
  )
}

const pillClass =
  'inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground'

function RowBadge({ row }: { row: ResultRow }) {
  if (row.category === 'pending') {
    return (
      <>
        <span className="sr-only">Checking</span>
        <span aria-hidden="true" className="h-5 w-20 animate-pulse rounded-full bg-muted" />
      </>
    )
  }
  if (row.category === 'unchecked') {
    return (
      <span className={pillClass}>
        <CircleHelp className="size-3" strokeWidth={3} aria-hidden="true" />
        Not checked
      </span>
    )
  }
  if (row.label) {
    return (
      <span className={pillClass}>
        <Minus className="size-3" strokeWidth={3} aria-hidden="true" />
        {row.label}
      </span>
    )
  }
  return row.status ? <ResultStatus status={row.status} /> : null
}

function BulkEmpty() {
  return (
    <div className="rounded-[2rem] border border-brand-subtle-border bg-brand-subtle p-8 text-center sm:p-12">
      <p className="font-semibold text-foreground">Paste a list to check it in one go</p>
      <p className="mx-auto mt-2 max-w-md text-pretty text-sm/6 text-muted-foreground">
        Up to {BULK_MAX_NAMES} names, one per line, or a CSV file. Each gets its own answer with its
        first-year and renewal price, and you can download the results as a CSV file.
      </p>
      <noscript>
        <p className="mx-auto mt-4 max-w-md text-pretty text-sm/6 font-medium text-foreground">
          Bulk search needs JavaScript to check a list. To check one name, use the search on the
          home page.
        </p>
      </noscript>
    </div>
  )
}
