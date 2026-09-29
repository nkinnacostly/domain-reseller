import type { AvailabilityResult, AvailabilityStatus } from '@dr/shared'
import type { PublicPriceRow } from '@/features/pricing/lib/public-row'
import { isIdn, toUnicodeHost } from './idn'
import { describeLengthIssue, type LengthIssue } from './length'

/**
 * One search result as the page shows it. Prices are the catalogue's — the
 * same path as /pricing — so a domain cannot cost one thing here and another
 * there. Cost and margin never reach this type (see toPublicRow).
 */
export type SearchRow = {
  /** The ASCII form — what the supplier was asked about and what a cart stores. */
  domain: string
  /** How people read it: Unicode for an international name (FR-S8), else the same as `domain`. */
  display: string
  name: string
  tld: string
  status: AvailabilityStatus
  /** FR-S9 — refused by the extension's length rule here, without asking the supplier. */
  lengthIssue?: LengthIssue
  /** Null only if the catalogue has no price — then we show none (N5b). */
  price: {
    /** The shortest registration, for `registerYears` years — the first year for most. */
    register: string
    registerYears: number
    /** The shortest renewal, for `renewYears` years (N8). */
    renew: string
    renewYears: number
    renewalIsHigher: boolean
    /** gTLDs carry the ICANN fee, and it is already in the price (FR-S2). */
    includesIcannFee: boolean
    maxPeriod: number
  } | null
}

export function toSearchRows(
  results: AvailabilityResult[],
  prices: ReadonlyMap<string, PublicPriceRow>,
): SearchRow[] {
  return results.map((result) => {
    const row = prices.get(result.tld)
    return {
      domain: result.domain,
      display: toUnicodeHost(result.domain),
      name: result.name,
      tld: result.tld,
      status: result.status,
      price: row
        ? {
            register: row.register,
            registerYears: row.registerYears,
            renew: row.renew,
            renewYears: row.renewYears,
            renewalIsHigher: row.renewalIsHigher,
            includesIcannFee: !row.isCountryCode,
            maxPeriod: row.maxPeriod,
          }
        : null,
    }
  })
}

/**
 * A name the extension's length rule refuses (FR-S9). Shown like any refusal,
 * with the rule, and never priced: it cannot be bought.
 */
export function lengthRow(name: string, tld: string, issue: LengthIssue): SearchRow {
  const domain = `${name}.${tld}`
  return {
    domain,
    display: toUnicodeHost(domain),
    name,
    tld,
    status: 'restricted',
    lengthIssue: issue,
    price: null,
  }
}

/**
 * Why a row cannot be bought, where there is something specific to say: the
 * length rule it breaks (FR-S9), or a registry that refused an international
 * name (FR-S8 — whether an extension takes one is the supplier's answer).
 */
export function refusalNote(row: SearchRow): string | null {
  if (row.lengthIssue) return describeLengthIssue(row.lengthIssue, row.name, row.tld)
  if (row.status === 'restricted' && isIdn(row.domain)) {
    return 'Not available for this extension — its registry did not accept this international name'
  }
  return null
}

/** FR-S4 — how many alternatives to show. */
export const SUGGESTION_COUNT = 12

/**
 * Available alternatives only. Ranked as ADR-002 orders them — the more
 * popular extension first, then the affix order — so a free `.com` always
 * beats a free `.net`.
 */
export function pickSuggestions(
  rows: SearchRow[],
  tldOrder: readonly string[],
  count = SUGGESTION_COUNT,
): SearchRow[] {
  const rank = (tld: string) => {
    const index = tldOrder.indexOf(tld)
    return index === -1 ? tldOrder.length : index
  }
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.status === 'available' && row.price)
    .sort((a, b) => rank(a.row.tld) - rank(b.row.tld) || a.index - b.index)
    .slice(0, count)
    .map(({ row }) => row)
}
