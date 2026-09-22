import type { AvailabilityResult, AvailabilityStatus } from '@dr/shared'
import type { PublicPriceRow } from '@/features/pricing/lib/public-row'

/**
 * One search result as the page shows it. Prices are the catalogue's — the
 * same path as /pricing — so a domain cannot cost one thing here and another
 * there. Cost and margin never reach this type (see toPublicRow).
 */
export type SearchRow = {
  domain: string
  name: string
  tld: string
  status: AvailabilityStatus
  /** Null only if the catalogue has no price — then we show none (N5b). */
  price: {
    register: string
    renew: string
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
      name: result.name,
      tld: result.tld,
      status: result.status,
      price: row
        ? {
            register: row.register,
            renew: row.renew,
            renewalIsHigher: row.renewalIsHigher,
            includesIcannFee: !row.isCountryCode,
            maxPeriod: row.maxPeriod,
          }
        : null,
    }
  })
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
