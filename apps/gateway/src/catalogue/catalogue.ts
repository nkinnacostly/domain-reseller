import type { Database } from '@dr/db'

/**
 * The supplier's catalogue as the `tlds` table holds it — the only source of
 * wholesale cost (N5b). Pure: supplier.ts reads the listing, store.ts writes
 * the rows; this decides what the rows are, what changed, and whether the
 * listing can be trusted at all.
 */

/** One extension as `GET products/tlds` lists it (read 24 Sept 2026). */
export type RawTld = {
  name?: unknown
  minRegistrationPeriod?: unknown
  maxRegistrationPeriod?: unknown
  /**
   * The years the registry sells a registration and a renewal for — `[2, 4,
   * 6, 8, 10]` for .ai on 29 Sept 2026, every year for most. The price list
   * can list more (.ai prices renewals of 3, 5, 7 and 9 years that the
   * registry does not sell), so a period is offered only where both agree.
   */
  registrationPeriods?: unknown
  renewalPeriods?: unknown
  deletionRestorablePeriod?: unknown
  prices?: unknown
  attributes?: unknown
  /**
   * The SDK's GetTldList reads label limits from here (`minLength`, and
   * `maxLenght`, sic), defaulting to 1 and 63 when absent. The production
   * listing carries no `constraints` at all, so a missing limit is stored as
   * unknown, never as the SDK's default.
   */
  constraints?: unknown
}

export type Listing = { items: RawTld[]; total: number | null }

/** What the sync writes for one extension. */
export type TldRow = {
  name: string
  register_usd: number
  renew_usd: number
  transfer_usd: number | null
  restore_usd: number | null
  /** The shortest and longest registration sold: the first and last of `register_periods`. */
  min_period: number
  max_period: number
  register_periods: number[]
  renew_periods: number[]
  redemption_days: number
  requires_extra_fields: boolean
  min_chars: number | null
  max_chars: number | null
  is_transferable: boolean | null
  is_sellable: true
}

type TldTable = Database['public']['Tables']['tlds']['Row']

/** What the table holds now, for the columns the sync owns. */
export type CurrentTld = Pick<
  TldTable,
  | 'name'
  | 'register_usd'
  | 'renew_usd'
  | 'transfer_usd'
  | 'restore_usd'
  | 'min_period'
  | 'max_period'
  | 'register_periods'
  | 'renew_periods'
  | 'redemption_days'
  | 'requires_extra_fields'
  | 'min_chars'
  | 'max_chars'
  | 'is_transferable'
  | 'is_sellable'
>

/** The columns the sync owns — every other column of `tlds` is ours to set. */
export const CURRENT_TLD_COLUMNS = [
  'name',
  'register_usd',
  'renew_usd',
  'transfer_usd',
  'restore_usd',
  'min_period',
  'max_period',
  'register_periods',
  'renew_periods',
  'redemption_days',
  'requires_extra_fields',
  'min_chars',
  'max_chars',
  'is_transferable',
  'is_sellable',
] as const satisfies readonly (keyof CurrentTld)[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The columns are numeric(12,4): a price with more places would read back as a change every run. */
const toColumn = (usd: number) => Math.round(usd * 10_000) / 10_000

/**
 * The one-year price of a kind (`register`, `renew`, `transfer`, `restore`),
 * or null when none is listed. Only USD: the float is in dollars, and a price
 * in another currency read as dollars would be a wrong price, which is worse
 * than none (N5b). A listed price without a currency has always been dollars.
 */
export function priceOf(tld: RawTld, kind: string, period = 1): number | null {
  if (!Array.isArray(tld.prices)) return null
  for (const group of tld.prices) {
    if (!isRecord(group)) continue
    const rows = group[kind]
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (!isRecord(row) || row.period !== period) continue
      const { price, currency } = row
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) continue
      if (currency !== undefined && String(currency).toUpperCase() !== 'USD') continue
      return toColumn(price)
    }
  }
  return null
}

/** Whether the listing names any price at all for a kind, at any period. */
function listsKind(tld: RawTld, kind: string): boolean {
  if (!Array.isArray(tld.prices)) return false
  return tld.prices.some(
    (group) => isRecord(group) && Array.isArray(group[kind]) && group[kind].length > 0,
  )
}

/**
 * Only a genuinely REQUIRED field is an eligibility restriction. Optional
 * acknowledgements — .app's SSL notice, say — must not be shown as one, or we
 * deter people from a TLD that needs nothing extra.
 */
export function requiresExtraFields(tld: RawTld): boolean {
  if (!Array.isArray(tld.attributes)) return false
  return tld.attributes.some(
    (attribute) =>
      isRecord(attribute) && attribute.isRequired === true && attribute.type !== 'Label',
  )
}

/** DNS allows 1 to 63 characters in a label; anything else is not a limit we can use. */
function labelLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 63
    ? value
    : null
}

/** The registry's shortest and longest label, or nulls when the listing does not say. */
export function charLimits(tld: RawTld): { min_chars: number | null; max_chars: number | null } {
  if (!isRecord(tld.constraints)) return { min_chars: null, max_chars: null }
  const min = labelLimit(tld.constraints.minLength)
  const max = labelLimit(tld.constraints.maxLength ?? tld.constraints.maxLenght)
  if (min !== null && max !== null && min > max) return { min_chars: null, max_chars: null }
  return { min_chars: min, max_chars: max }
}

/**
 * Whether the supplier takes transfers in. The listing has no flag for it
 * (PRD §5's `IsTransferable` is SOAP-only), only the transfer price:
 * a positive price → yes; no transfer price at all → no, there is nothing to
 * sell; a price of 0 (listed for .uk, .ch, .ng, .au and ~60 others on
 * 24 Sept 2026) → unknown — a free registry-side move or no product at all,
 * and not something to sell on a guess.
 */
export function transferability(tld: RawTld): boolean | null {
  const price = priceOf(tld, 'transfer')
  if (price !== null) return price > 0 ? true : null
  return listsKind(tld, 'transfer') ? null : false
}

/** A count of days; anything else falls back to the default the script always used. */
const whole = (value: unknown, fallback: number, min: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 1_000
    ? value
    : fallback

/** A registry holds a domain at most ten years ahead, so no period is longer. */
const MAX_YEARS = 10

const isYears = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_YEARS

/** Prices in ten-thousandths of a dollar — the column's four places, as whole numbers. */
const units = (usd: number) => Math.round(usd * 10_000)
const dollars = (tenThousandths: number) => tenThousandths / 10_000

/** The USD prices a kind lists, by period, in ten-thousandths. */
function listedPrices(tld: RawTld, kind: string): Map<number, number> {
  const prices = new Map<number, number>()
  if (!Array.isArray(tld.prices)) return prices
  for (const group of tld.prices) {
    if (!isRecord(group) || !Array.isArray(group[kind])) continue
    for (const row of group[kind]) {
      if (!isRecord(row) || !isYears(row.period) || prices.has(row.period)) continue
      const { price, currency } = row
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue
      if (currency !== undefined && String(currency).toUpperCase() !== 'USD') continue
      prices.set(row.period, units(price))
    }
  }
  return prices
}

/**
 * Splits listed prices into the periods the registry sells and the rest:
 * `sold` is the listing's own list of periods where it gives a usable one,
 * narrowed by `bounds` where those are usable.
 */
function onlySold(
  prices: Map<number, number>,
  sold: unknown,
  bounds?: { min: unknown; max: unknown },
): { sold: Map<number, number>; unsold: number[] } {
  const listed = Array.isArray(sold) ? new Set(sold.filter(isYears)) : null
  const { min, max } = bounds ?? {}
  const bounded = isYears(min) && isYears(max) && min <= max
  const kept = new Map<number, number>()
  const unsold: number[] = []
  for (const [period, price] of prices) {
    const outside =
      (listed !== null && !listed.has(period)) ||
      (bounded && (period < (min as number) || period > (max as number)))
    if (outside) unsold.push(period)
    else kept.set(period, price)
  }
  return { sold: kept, unsold: ascending(unsold) }
}

/**
 * Our cost for a period may exceed the supplier's listed price by less than
 * a cent — a per-year rate is rounded up to four places — and never fall
 * below it: priced below cost, every sale of that period loses money.
 */
const CENT = 100
const matchesListed = (derived: number, listed: number) =>
  derived >= listed && derived - listed < CENT

/** What an extension is sold for, or why it cannot be sold. */
export type SellingTerms =
  | {
      ok: true
      /** Per year, in USD: the first term's price over its years. */
      registerUsd: number
      /** Per year, in USD: the shortest renewal's price over its years. */
      renewUsd: number
      registerPeriods: number[]
      renewPeriods: number[]
      /** Periods priced off the per-year rate — not offered. */
      dropped: { register: number[]; renew: number[] }
      /** Periods priced, but not ones the registry sells — not offered. */
      unsold: { register: number[]; renew: number[] }
    }
  | { ok: false; reason: string }

function ascending(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b)
}

/**
 * The periods we offer, and the per-year costs they are priced from (N5b, N9b).
 *
 * The storefront charges the first term at the registration rate for each of
 * its years and every later year at the renewal rate, and a renewal at the
 * renewal rate each year (`periodTotalKobo`, `renewalTotalKobo` in
 * @dr/shared). So each rate is the shortest listed term's price over its
 * years — .ai's two-year $199.80 is $99.90 a year — and a period is offered
 * only when the supplier's listed price for it is what that rule gives, to
 * the cent. Any other period would be charged at something other than it
 * costs us: .ai's three-year renewal is listed at $599.40, not 3 × $99.90,
 * and .me's two-year registration at $28.53, not its $2.29 first year plus a
 * $22.99 renewal. Those are left out and reported.
 *
 * For an extension sold every year at steady prices this is the one-year
 * price and every year from 1 to 10 — exactly what was stored before.
 */
export function sellingTerms(tld: RawTld): SellingTerms {
  const registering = onlySold(listedPrices(tld, 'register'), tld.registrationPeriods, {
    min: tld.minRegistrationPeriod,
    max: tld.maxRegistrationPeriod,
  })
  const renewing = onlySold(listedPrices(tld, 'renew'), tld.renewalPeriods)
  const register = registering.sold
  const renew = renewing.sold

  const first = Math.min(...register.keys())
  const firstPrice = register.get(first)
  if (firstPrice === undefined) return { ok: false, reason: 'no register price' }
  const shortest = Math.min(...renew.keys())
  const shortestPrice = renew.get(shortest)
  // A renewal price is shown beside every price (N8); one never listed cannot be.
  if (shortestPrice === undefined) return { ok: false, reason: 'no renewal price' }

  const registerRate = Math.ceil(firstPrice / first)
  const renewRate = Math.ceil(shortestPrice / shortest)

  const registerPeriods: number[] = []
  const renewPeriods: number[] = []
  const dropped = { register: [] as number[], renew: [] as number[] }
  for (const period of ascending(register.keys())) {
    const derived = registerRate * first + renewRate * (period - first)
    if (matchesListed(derived, register.get(period) ?? 0)) registerPeriods.push(period)
    else dropped.register.push(period)
  }
  for (const period of ascending(renew.keys())) {
    if (matchesListed(renewRate * period, renew.get(period) ?? 0)) renewPeriods.push(period)
    else dropped.renew.push(period)
  }

  return {
    ok: true,
    registerUsd: dollars(registerRate),
    renewUsd: dollars(renewRate),
    registerPeriods,
    renewPeriods,
    dropped,
    unsold: { register: registering.unsold, renew: renewing.unsold },
  }
}

/** A sellable row, or null for an extension we cannot price (see sellingTerms). */
export function toRow(tld: RawTld): TldRow | null {
  if (typeof tld.name !== 'string' || tld.name.trim() === '') return null
  const terms = sellingTerms(tld)
  if (!terms.ok) return null
  const first = terms.registerPeriods[0] ?? 1

  return {
    name: tld.name.trim(),
    register_usd: terms.registerUsd,
    renew_usd: terms.renewUsd,
    transfer_usd: priceOf(tld, 'transfer'),
    restore_usd: priceOf(tld, 'restore'),
    min_period: first,
    max_period: terms.registerPeriods.at(-1) ?? first,
    register_periods: terms.registerPeriods,
    renew_periods: terms.renewPeriods,
    redemption_days: whole(tld.deletionRestorablePeriod, 0, 0),
    requires_extra_fields: requiresExtraFields(tld),
    ...charLimits(tld),
    is_transferable: transferability(tld),
    is_sellable: true,
  }
}

/** Sellable rows by name. A name listed twice keeps its first listing. */
export function toRows(items: RawTld[]): TldRow[] {
  const rows = new Map<string, TldRow>()
  for (const item of items) {
    const row = toRow(item)
    if (row && !rows.has(row.name)) rows.set(row.name, row)
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * What a person should know about the terms before the sync writes them:
 * extensions sold in blocks, periods left out because the supplier prices
 * them off the per-year rate, and extensions that list prices but cannot be
 * sold. Extensions that list no price at all are only counted.
 */
type Periods = { name: string; register: number[]; renew: number[] }

export type TermsNotes = {
  multiYear: TldRow[]
  /** Priced off the per-year rate. */
  dropped: Periods[]
  /** Priced, but not periods the registry sells. */
  unsold: Periods[]
  unsellable: { name: string; reason: string }[]
  unpriced: number
}

export function termsNotes(items: RawTld[]): TermsNotes {
  const notes: TermsNotes = {
    multiYear: [],
    dropped: [],
    unsold: [],
    unsellable: [],
    unpriced: 0,
  }
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item.name !== 'string' || item.name.trim() === '') continue
    const name = item.name.trim()
    if (seen.has(name)) continue
    seen.add(name)
    const terms = sellingTerms(item)
    if (!terms.ok) {
      if (listsKind(item, 'register') || listsKind(item, 'renew')) {
        notes.unsellable.push({ name, reason: terms.reason })
      } else {
        notes.unpriced += 1
      }
      continue
    }
    const row = toRow(item)
    if (row && (row.register_periods[0] !== 1 || row.renew_periods[0] !== 1)) {
      notes.multiYear.push(row)
    }
    if (terms.dropped.register.length > 0 || terms.dropped.renew.length > 0) {
      notes.dropped.push({ name, ...terms.dropped })
    }
    if (terms.unsold.register.length > 0 || terms.unsold.renew.length > 0) {
      notes.unsold.push({ name, ...terms.unsold })
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  notes.multiYear.sort(byName)
  notes.dropped.sort(byName)
  notes.unsold.sort(byName)
  notes.unsellable.sort(byName)
  return notes
}

export type PriceChange = { row: TldRow; before: CurrentTld }

export type CatalogueDiff = {
  added: TldRow[]
  /** Sellable now and gone from the listing: they stop being sold. */
  retired: string[]
  priceChanges: PriceChange[]
  /** Periods, label limits, transferability, eligibility, or sellable again. */
  detailChanges: string[]
  unchanged: number
}

const money = (value: number | null) => (value === null ? null : Number(value))

function pricesDiffer(row: TldRow, before: CurrentTld): boolean {
  return (
    money(before.register_usd) !== row.register_usd ||
    money(before.renew_usd) !== row.renew_usd ||
    money(before.transfer_usd) !== row.transfer_usd ||
    money(before.restore_usd) !== row.restore_usd
  )
}

/**
 * The periods a stored row sells: one written before migration 37 lists
 * none, and sells every year from its minimum to its maximum.
 */
export function periodsOf(
  row: Pick<CurrentTld, 'min_period' | 'max_period'> & {
    register_periods?: number[] | null
    renew_periods?: number[] | null
  },
): { register: number[]; renew: number[] } {
  const every: number[] = []
  for (let year = row.min_period; year <= row.max_period; year += 1) every.push(year)
  return { register: row.register_periods ?? every, renew: row.renew_periods ?? every }
}

const samePeriods = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((year, index) => year === b[index])

function detailsDiffer(row: TldRow, before: CurrentTld): boolean {
  const was = periodsOf(before)
  return (
    !before.is_sellable ||
    before.min_period !== row.min_period ||
    before.max_period !== row.max_period ||
    !samePeriods(was.register, row.register_periods) ||
    !samePeriods(was.renew, row.renew_periods) ||
    before.redemption_days !== row.redemption_days ||
    before.requires_extra_fields !== row.requires_extra_fields ||
    before.min_chars !== row.min_chars ||
    before.max_chars !== row.max_chars ||
    before.is_transferable !== row.is_transferable
  )
}

export function compareCatalogue(rows: TldRow[], current: CurrentTld[]): CatalogueDiff {
  const before = new Map(current.map((row) => [row.name, row]))
  const listed = new Set(rows.map((row) => row.name))

  const diff: CatalogueDiff = {
    added: [],
    retired: current
      .filter((row) => row.is_sellable && !listed.has(row.name))
      .map((row) => row.name)
      .sort(),
    priceChanges: [],
    detailChanges: [],
    unchanged: 0,
  }
  for (const row of rows) {
    const previous = before.get(row.name)
    if (!previous) {
      diff.added.push(row)
      continue
    }
    const priced = pricesDiffer(row, previous)
    const detailed = detailsDiffer(row, previous)
    if (priced) diff.priceChanges.push({ row, before: previous })
    if (detailed) diff.detailChanges.push(row.name)
    if (!priced && !detailed) diff.unchanged += 1
  }
  return diff
}

export const hasChanges = (diff: CatalogueDiff) =>
  diff.added.length > 0 ||
  diff.retired.length > 0 ||
  diff.priceChanges.length > 0 ||
  diff.detailChanges.length > 0

/**
 * A weekly job runs unattended, so it refuses a listing that is plainly
 * broken rather than writing it: a short read would retire every extension it
 * missed, and nothing on the storefront could be sold again until someone
 * noticed. Real catalogue changes are a handful of extensions at a time.
 */
const RETIRE_FLOOR = 25
const RETIRE_SHARE = 0.1

/** Why the listing cannot be trusted, or null when it can. */
export function listingRefusal(listing: Listing, rows: TldRow[]): string | null {
  if (listing.total === null) {
    return 'The supplier did not say how many extensions it has, so the listing cannot be checked'
  }
  if (listing.items.length !== listing.total) {
    return `The supplier said ${listing.total} extensions and listed ${listing.items.length}`
  }
  if (rows.length === 0) return 'The listing has no extension with a register price'
  return null
}

export function retirementRefusal(diff: CatalogueDiff, current: CurrentTld[]): string | null {
  const sellable = current.filter((row) => row.is_sellable).length
  const limit = Math.max(RETIRE_FLOOR, Math.ceil(sellable * RETIRE_SHARE))
  return diff.retired.length > limit
    ? `Would stop selling ${diff.retired.length} of ${sellable} extensions at once (limit ${limit})`
    : null
}

const usd = (value: number | null) => (value === null ? '—' : `$${value.toFixed(2)}`)

/** "1–10", "2 4 6 8 10", "1–3 5": periods, with runs of three or more joined. */
export function yearsList(periods: readonly number[]): string {
  const parts: string[] = []
  for (let at = 0; at < periods.length; ) {
    let end = at
    while (end + 1 < periods.length && periods[end + 1] === (periods[end] ?? 0) + 1) end += 1
    if (end - at >= 2) parts.push(`${periods[at]}–${periods[end]}`)
    else for (let i = at; i <= end; i += 1) parts.push(String(periods[i]))
    at = end + 1
  }
  return parts.join(' ')
}

const LIST_LIMIT = 30

/** The terms part of the report: blocks, periods left out, extensions not sold. */
function formatNotes(notes: TermsNotes): string[] {
  const lines: string[] = []
  if (notes.multiYear.length > 0) {
    lines.push('', 'Sold in multi-year terms (years a registration · a renewal can be bought for):')
    for (const row of notes.multiYear.slice(0, LIST_LIMIT)) {
      lines.push(
        `  .${row.name.padEnd(16)}register ${yearsList(row.register_periods)} · ` +
          `renew ${yearsList(row.renew_periods)}   ` +
          `(${usd(row.register_usd)}/yr, renews ${usd(row.renew_usd)}/yr)`,
      )
    }
    if (notes.multiYear.length > LIST_LIMIT) {
      lines.push(`  … and ${notes.multiYear.length - LIST_LIMIT} more`)
    }
  }
  const periodLines = (heading: string, entries: Periods[]) => {
    if (entries.length === 0) return
    lines.push('', heading)
    for (const entry of entries.slice(0, LIST_LIMIT)) {
      const parts = [
        entry.register.length > 0 ? `register ${yearsList(entry.register)}` : null,
        entry.renew.length > 0 ? `renew ${yearsList(entry.renew)}` : null,
      ].filter(Boolean)
      lines.push(`  .${entry.name.padEnd(16)}${parts.join(' · ')}`)
    }
    if (entries.length > LIST_LIMIT) lines.push(`  … and ${entries.length - LIST_LIMIT} more`)
  }
  periodLines(
    'Periods not offered — priced off the per-year rate, so we would charge other than they cost:',
    notes.dropped,
  )
  periodLines('Periods not offered — priced, but not ones the registry sells:', notes.unsold)
  if (notes.unsellable.length > 0) {
    const names = notes.unsellable
      .slice(0, LIST_LIMIT)
      .map((entry) => `.${entry.name} (${entry.reason})`)
    const more =
      notes.unsellable.length > LIST_LIMIT
        ? ` … and ${notes.unsellable.length - LIST_LIMIT} more`
        : ''
    lines.push('', `Not sold — listed with prices we cannot state: ${names.join(', ')}${more}`)
  }
  if (notes.unpriced > 0) {
    lines.push('', `${notes.unpriced} listed with no price at all.`)
  }
  return lines
}

/** The report a person reads: every change, before anything is written. */
export function formatReport(
  diff: CatalogueDiff,
  listed: number,
  sellable: number,
  notes?: TermsNotes,
): string[] {
  const lines = [
    `Fetched ${listed} extensions from the reseller platform; ${sellable} sellable`,
    '',
    `+${diff.added.length} added · -${diff.retired.length} retired · ` +
      `~${diff.priceChanges.length} price changes · ~${diff.detailChanges.length} other changes · ` +
      `${diff.unchanged} unchanged`,
  ]
  if (diff.added.length > 0) {
    lines.push('', `Added:   ${diff.added.map((row) => `.${row.name}`).join(' ')}`)
  }
  if (diff.retired.length > 0) {
    lines.push(
      '',
      `Retired: ${diff.retired.map((name) => `.${name}`).join(' ')}`,
      '         Marked unsellable — anything already sold still needs renewing.',
    )
  }
  if (diff.priceChanges.length > 0) {
    lines.push('', 'Wholesale changes:')
    for (const { row, before } of diff.priceChanges.slice(0, 30)) {
      lines.push(
        `  .${row.name.padEnd(16)}` +
          `register ${usd(money(before.register_usd))} → ${usd(row.register_usd)}` +
          `   renew ${usd(money(before.renew_usd))} → ${usd(row.renew_usd)}`,
      )
    }
    if (diff.priceChanges.length > 30) lines.push(`  … and ${diff.priceChanges.length - 30} more`)
  }
  if (diff.detailChanges.length > 0) {
    const names = diff.detailChanges.slice(0, 30).map((name) => `.${name}`)
    const more =
      diff.detailChanges.length > 30 ? ` … and ${diff.detailChanges.length - 30} more` : ''
    lines.push(
      '',
      `Other changes (periods, limits, transfers, eligibility): ${names.join(' ')}${more}`,
    )
  }
  if (notes) lines.push(...formatNotes(notes))
  return lines
}
