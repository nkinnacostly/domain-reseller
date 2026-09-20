import type { FxSettings } from '@dr/shared'
import { findTld, formatNaira, quote } from '@dr/shared'

/**
 * The extensions merchandised on the home page.
 *
 * Priced through the SAME policy as the pricing page — there is one pricing
 * path in this codebase and this is it. A second path drifted once already:
 * the home page showed .com at ₦22,900 while /pricing showed ₦20,500 for the
 * same domain, because it carried its own hardcoded costs and a flat margin.
 */
const FEATURED: { tld: string; blurb: string }[] = [
  { tld: 'ng', blurb: 'Nigeria, short and unmistakable' },
  { tld: 'com.ng', blurb: 'The trusted Nigerian business address' },
  { tld: 'com', blurb: 'The one everybody types first' },
]

export type FeaturedTld = {
  tld: string
  blurb: string
  firstYear: string
  renewal: string
  renewalIsHigher: boolean
}

export function featuredTlds(fx: FxSettings): FeaturedTld[] {
  const out: FeaturedTld[] = []

  for (const { tld, blurb } of FEATURED) {
    const entry = findTld(tld)
    if (!entry) continue

    const registration = quote(entry, 'registration', fx)
    const renewal = quote(entry, 'renewal', fx)
    if (!registration || !renewal) continue

    out.push({
      tld,
      blurb,
      firstYear: formatNaira(registration.priceKobo),
      renewal: formatNaira(renewal.priceKobo),
      renewalIsHigher: renewal.priceKobo > registration.priceKobo,
    })
  }

  return out
}
