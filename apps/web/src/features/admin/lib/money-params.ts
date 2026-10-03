import { validDate } from './list-params'

/**
 * The Money page's URL (docs/ADMIN-SPEC.md §5.2 B7, §9's link contract):
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=day|week|month`. The overview links
 * here with `from` and `to` only. Parsing is strict — a date that is not a
 * real one, or a grain SQL does not know, falls back to the default rather
 * than reaching a query — and links are built from the parsed values.
 *
 * Days are calendar days in Lagos (WAT): SQL buckets `paid_at` with
 * `at time zone 'Africa/Lagos'`, and `from` and `to` are both included.
 */

export const GRAINS = ['day', 'week', 'month'] as const
export type Grain = (typeof GRAINS)[number]

/** `admin_revenue` and `admin_margin` refuse a wider range (`admin:bad_range`). */
export const MAX_SPAN_DAYS = 1100

/** With no dates in the URL: the last 30 days, as the overview's default period reads them. */
export const DEFAULT_SPAN_DAYS = 30

export type MoneyParams = {
  from: string
  to: string
  grain: Grain
  /** The grain came from the URL; otherwise it follows the span. */
  grainChosen: boolean
  /** The dates asked for were wider than SQL allows, so `from` was moved. */
  clamped: boolean
}

type Search = Record<string, string | string[] | undefined>

const DAY_MS = 86_400_000

function first(search: Search, key: string): string | undefined {
  const value = search[key]
  return Array.isArray(value) ? value[0] : value
}

const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Africa/Lagos',
})

/** `YYYY-MM-DD` in Lagos time. */
export function lagosDay(date: Date): string {
  return LAGOS_DAY.format(date)
}

const epoch = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** A calendar day moved by whole days. */
export function addDays(day: string, days: number): string {
  return new Date(epoch(day) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (0 for the same day). */
export function daysBetween(from: string, to: string): number {
  return Math.round((epoch(to) - epoch(from)) / DAY_MS)
}

/** The grain a span reads best at when none is chosen: no more than about 90 bars. */
export function autoGrain(spanDays: number): Grain {
  if (spanDays <= 92) return 'day'
  if (spanDays <= 366) return 'week'
  return 'month'
}

export function parseMoneyParams(search: Search, now: Date): MoneyParams {
  const today = lagosDay(now)
  let from = validDate(first(search, 'from'))
  let to = validDate(first(search, 'to'))
  if (!from && !to) {
    to = today
    from = lagosDay(new Date(now.getTime() - DEFAULT_SPAN_DAYS * DAY_MS))
  } else if (!from && to) {
    from = addDays(to, -DEFAULT_SPAN_DAYS)
  } else if (from && !to) {
    to = from > today ? from : today
  }
  // Both are set by here; TypeScript cannot follow the branches.
  let start = from as string
  let end = to as string
  if (start > end) [start, end] = [end, start]
  let clamped = false
  if (daysBetween(start, end) > MAX_SPAN_DAYS) {
    start = addDays(end, -MAX_SPAN_DAYS)
    clamped = true
  }
  const grainText = first(search, 'grain')
  const chosen = (GRAINS as readonly string[]).includes(grainText ?? '')
  const grain = chosen ? (grainText as Grain) : autoGrain(daysBetween(start, end))
  return { from: start, to: end, grain, grainChosen: chosen, clamped }
}

/** A link to the page with these dates, and the grain when one was chosen. */
export function moneyHref(params: { from: string; to: string; grain?: Grain | null }): string {
  const query = new URLSearchParams({ from: params.from, to: params.to })
  if (params.grain) query.set('grain', params.grain)
  return `/admin/money?${query.toString()}`
}

/** The same dates at another grain. */
export function grainHref(params: Pick<MoneyParams, 'from' | 'to'>, grain: Grain): string {
  return moneyHref({ from: params.from, to: params.to, grain })
}

/** The kinds the orders list filters by (§9's link contract: `?kind=`). */
const ORDER_KINDS = ['register', 'renew', 'transfer', 'ssl']

/**
 * The orders list over a figure's days, by §9's link contract: `/admin/orders` with
 * `?from=&to=`, and `?kind=` for a known line type.
 */
export function ordersHref(range: { from: string; to: string }, kind?: string | null): string {
  const query = new URLSearchParams()
  if (kind && ORDER_KINDS.includes(kind)) query.set('kind', kind)
  query.set('from', range.from)
  query.set('to', range.to)
  return `/admin/orders?${query.toString()}`
}

/** The supplier's ledger, where a lost line's charge is matched. */
export const LEDGER_HREF = '/admin/supplier/ledger'

/** A wider look for an empty page: the last 12 months to today, by month. */
export function lastYearHref(now: Date): string {
  const to = lagosDay(now)
  return moneyHref({ from: addDays(to, -365), to, grain: 'month' })
}

export const GRAIN_LABEL: Record<Grain, string> = { day: 'Day', week: 'Week', month: 'Month' }

/** "by day", "by week", "by month". */
export function byGrain(grain: Grain): string {
  return `by ${grain}`
}

const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})
const MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

const asDate = (day: string) => new Date(epoch(day))

/** "3 Oct 2026". */
export function formatDay(day: string): string {
  return DAY_MONTH_YEAR.format(asDate(day))
}

/** "3 Sep – 3 Oct 2026", "29 Dec 2025 – 4 Jan 2026", "1–4 Oct 2026", or one day. */
export function formatSpan(from: string, to: string): string {
  if (from === to) return formatDay(from)
  const [fy, fm] = from.split('-')
  const [ty, tm] = to.split('-')
  if (fy !== ty) return `${formatDay(from)} – ${formatDay(to)}`
  if (fm !== tm) return `${DAY_MONTH.format(asDate(from))} – ${formatDay(to)}`
  return `${Number(from.slice(8))}–${formatDay(to)}`
}

/** The last day of the bucket that starts on `bucket`. */
function bucketEnd(bucket: string, grain: Grain): string {
  if (grain === 'day') return bucket
  if (grain === 'week') return addDays(bucket, 6)
  const date = asDate(bucket)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10)
}

/**
 * The days a bucket covers inside the dates chosen. SQL starts a week on
 * Monday and a month on the 1st, so the first and last bucket can begin
 * before `from` or end after `to`; only the days inside are counted.
 */
export function bucketSpan(
  bucket: string,
  grain: Grain,
  range: Pick<MoneyParams, 'from' | 'to'>,
): { start: string; end: string; partial: boolean } {
  const fullEnd = bucketEnd(bucket, grain)
  const start = bucket < range.from ? range.from : bucket
  const end = fullEnd > range.to ? range.to : fullEnd
  return { start, end, partial: start !== bucket || end !== fullEnd }
}

/** How a bucket is named in the table, the chart and the CSV: the days it covers. */
export function bucketLabel(
  bucket: string,
  grain: Grain,
  range: Pick<MoneyParams, 'from' | 'to'>,
): string {
  const span = bucketSpan(bucket, grain, range)
  if (grain === 'month' && !span.partial) return MONTH_YEAR.format(asDate(bucket))
  return formatSpan(span.start, span.end)
}
