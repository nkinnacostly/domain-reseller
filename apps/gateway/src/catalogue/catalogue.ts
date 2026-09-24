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
  min_period: number
  max_period: number
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
  | 'redemption_days'
  | 'requires_extra_fields'
  | 'min_chars'
  | 'max_chars'
  | 'is_transferable'
  | 'is_sellable'
>

export const CURRENT_TLD_COLUMNS =
  'name, register_usd, renew_usd, transfer_usd, restore_usd, min_period, max_period, redemption_days, requires_extra_fields, min_chars, max_chars, is_transferable, is_sellable'

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

/** A count of years or days; anything else falls back to the default the script always used. */
const whole = (value: unknown, fallback: number, min: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= 1_000
    ? value
    : fallback

/** A sellable row, or null for an extension we cannot price: no positive register price. */
export function toRow(tld: RawTld): TldRow | null {
  if (typeof tld.name !== 'string' || tld.name.trim() === '') return null
  const register = priceOf(tld, 'register')
  if (register === null || register <= 0) return null

  return {
    name: tld.name.trim(),
    register_usd: register,
    renew_usd: priceOf(tld, 'renew') ?? register,
    transfer_usd: priceOf(tld, 'transfer'),
    restore_usd: priceOf(tld, 'restore'),
    min_period: whole(tld.minRegistrationPeriod, 1, 1),
    max_period: whole(tld.maxRegistrationPeriod, 10, 1),
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

function detailsDiffer(row: TldRow, before: CurrentTld): boolean {
  return (
    !before.is_sellable ||
    before.min_period !== row.min_period ||
    before.max_period !== row.max_period ||
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

/** The report a person reads: every change, before anything is written. */
export function formatReport(diff: CatalogueDiff, listed: number, sellable: number): string[] {
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
  return lines
}
