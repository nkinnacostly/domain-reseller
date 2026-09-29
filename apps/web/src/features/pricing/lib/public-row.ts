import { formatNaira, type TldPricing } from '@dr/shared'

/**
 * What a price looks like to a customer.
 *
 * Deliberately narrow: wholesale cost and our margin are commercially
 * sensitive and must NEVER reach the browser. `toPublicRow` is the only way
 * pricing data crosses to a client component, and a test asserts the shape.
 */
export type PublicPriceRow = {
  tld: string
  /**
   * Display strings, already formatted — the client does no money maths.
   * `register` is the shortest registration the registry sells, for
   * `registerYears` years: the first year for most extensions, two years for
   * .ai. `renew` is the shortest renewal, for `renewYears` years (N8).
   */
  register: string
  registerYears: number
  renew: string
  renewYears: number
  transfer: string | null
  /** True when renewal costs more than the first year, so the UI can say so. */
  renewalIsHigher: boolean
  isCountryCode: boolean
  maxPeriod: number
  /** Registry requires extra identity or eligibility fields at checkout. */
  requiresExtraFields: boolean
  /** Sort key, so the client can order by price without seeing kobo maths. */
  registerRank: number
}

export function toPublicRow(pricing: TldPricing): PublicPriceRow {
  return {
    tld: pricing.tld,
    register: formatNaira(pricing.firstTerm.priceKobo),
    registerYears: pricing.firstTerm.years,
    renew: formatNaira(pricing.renewalTerm.priceKobo),
    renewYears: pricing.renewalTerm.years,
    transfer: pricing.transfer ? formatNaira(pricing.transfer.priceKobo) : null,
    renewalIsHigher: pricing.renewalIsHigher,
    isCountryCode: pricing.isCountryCode,
    maxPeriod: pricing.maxPeriod,
    requiresExtraFields: pricing.requiresExtraFields,
    // What the least anyone can pay is — for .ai, its two years.
    registerRank: pricing.firstTerm.priceKobo,
  }
}

/**
 * Extensions people in this market actually consider. Sorting the long tail by
 * price instead surfaces a wall of restricted Turkish second-levels (.gov.tr,
 * .edu.tr, .k12.tr) that nobody here can register — cheap, and useless.
 * Any TLD here that the catalogue does not sell is simply skipped.
 */
export const POPULAR_TLDS = [
  'com',
  'net',
  'org',
  'africa',
  'io',
  'co',
  'app',
  'dev',
  'ai',
  'me',
  'xyz',
  'online',
  'site',
  'shop',
  'store',
  'tech',
  'blog',
  'info',
  'biz',
  'cloud',
] as const

/**
 * Featured extensions first (in the order the database ranks them), then the
 * ones people recognise, then everything else alphabetically — predictable, so
 * a reader scanning for one extension can find it.
 */
export function sortForDisplay(
  rows: PublicPriceRow[],
  leading: readonly string[] = [],
): PublicPriceRow[] {
  const tier = (tld: string) => {
    const lead = leading.indexOf(tld)
    if (lead !== -1) return { band: 0, index: lead }
    const popular = (POPULAR_TLDS as readonly string[]).indexOf(tld)
    if (popular !== -1) return { band: 1, index: popular }
    return { band: 2, index: 0 }
  }

  return [...rows].sort((a, b) => {
    const ta = tier(a.tld)
    const tb = tier(b.tld)
    return ta.band - tb.band || ta.index - tb.index || a.tld.localeCompare(b.tld)
  })
}
