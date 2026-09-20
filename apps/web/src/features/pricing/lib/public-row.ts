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
  /** Display strings, already formatted — the client does no money maths. */
  register: string
  renew: string
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
    register: formatNaira(pricing.registration.priceKobo),
    renew: formatNaira(pricing.renewal.priceKobo),
    transfer: pricing.transfer ? formatNaira(pricing.transfer.priceKobo) : null,
    renewalIsHigher: pricing.renewalIsHigher,
    isCountryCode: pricing.isCountryCode,
    maxPeriod: pricing.maxPeriod,
    requiresExtraFields: pricing.requiresExtraFields,
    registerRank: pricing.registration.priceKobo,
  }
}

export const NIGERIAN_TLDS = ['ng', 'com.ng', 'net.ng', 'org.ng'] as const

/**
 * Extensions people in this market actually consider, in the order they
 * consider them. Sorting the full catalogue by price instead surfaces a wall
 * of restricted Turkish second-levels (.gov.tr, .edu.tr, .k12.tr) that nobody
 * here can register — cheap, and useless.
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
 * Nigerian range first, then the extensions people recognise, then everything
 * else alphabetically. Alphabetical beats price for the long tail: it is
 * predictable, and a reader scanning for one extension can find it.
 */
export function sortForDisplay(rows: PublicPriceRow[]): PublicPriceRow[] {
  const tier = (tld: string) => {
    const ng = (NIGERIAN_TLDS as readonly string[]).indexOf(tld)
    if (ng !== -1) return { band: 0, index: ng }
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
