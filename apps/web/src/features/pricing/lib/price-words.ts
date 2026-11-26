import { formatNaira, type TldPricing } from '@dr/shared'
import { priceWithRenewal } from './terms'

/** An extension's first term and its renewal, formatted from the tables (N5b). */
export function priceOf(pricing: TldPricing) {
  return {
    firstTerm: { naira: formatNaira(pricing.firstTerm.priceKobo), years: pricing.firstTerm.years },
    renewal: {
      naira: formatNaira(pricing.renewalTerm.priceKobo),
      years: pricing.renewalTerm.years,
    },
  }
}

/**
 * "₦18,300 for the first year, then ₦18,700 a year" — never a price without
 * its renewal (N8). Used where words, not a price card, carry the price: the
 * MCP server's answers and the site assistant's.
 */
export function priceWords(pricing: TldPricing): string {
  const price = priceOf(pricing)
  return priceWithRenewal(
    pricing.tld,
    { price: price.firstTerm.naira, years: price.firstTerm.years },
    { price: price.renewal.naira, years: price.renewal.years },
  )
}
