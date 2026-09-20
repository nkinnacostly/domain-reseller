import { computePrice, formatNaira } from '@dr/shared'

/**
 * Storefront pricing for the marketing page, computed rather than hardcoded.
 *
 * Wholesale costs are REAL — verified against the live catalogue on
 * 20 Sept 2026 at our `Reseller` tier (see apps/gateway/scripts/verify-supplier.ts).
 * The FX rate is a PLACEHOLDER until the `fx_rates` table and the daily job
 * exist (PRD FR-FX-1/2). Replace this module with a query then; nothing else
 * should need to change, because the shape is already the real one.
 */
const PLACEHOLDER_FX_MID_RATE = 1550
const PLACEHOLDER_FX_BUFFER_PCT = 4
const DEFAULT_MARGIN_PCT = 22

export type TldOffer = {
  tld: string
  /** Wholesale register cost, USD, 1 year. */
  costUsd: number
  /** Wholesale renew cost, USD, 1 year. */
  renewCostUsd: number
  /** gTLDs carry the USD 0.20/yr ICANN fee; ccTLDs such as .ng do not. */
  icannFeeApplies: boolean
  blurb: string
}

export const FEATURED_TLDS: TldOffer[] = [
  {
    tld: 'ng',
    costUsd: 11.99,
    renewCostUsd: 11.99,
    icannFeeApplies: false,
    blurb: 'Nigeria, short and unmistakable',
  },
  {
    tld: 'com.ng',
    costUsd: 11.99,
    renewCostUsd: 11.99,
    icannFeeApplies: false,
    blurb: 'The trusted Nigerian business address',
  },
  {
    tld: 'com',
    costUsd: 11.31,
    renewCostUsd: 11.51,
    icannFeeApplies: true,
    blurb: 'The one everybody types first',
  },
]

export type PricedTld = {
  tld: string
  blurb: string
  firstYear: string
  renewal: string
  /** True when renewal costs materially more than the first year. */
  renewalIsHigher: boolean
}

export function priceTld(offer: TldOffer): PricedTld {
  const shared = {
    periodYears: 1,
    icannFeeApplies: offer.icannFeeApplies,
    fxMidRate: PLACEHOLDER_FX_MID_RATE,
    fxBufferPct: PLACEHOLDER_FX_BUFFER_PCT,
    marginPct: DEFAULT_MARGIN_PCT,
  }

  const first = computePrice({ ...shared, supplierCostUsd: offer.costUsd })
  const renew = computePrice({ ...shared, supplierCostUsd: offer.renewCostUsd })

  return {
    tld: offer.tld,
    blurb: offer.blurb,
    firstYear: formatNaira(first.subtotalKobo),
    renewal: formatNaira(renew.subtotalKobo),
    renewalIsHigher: renew.subtotalKobo > first.subtotalKobo,
  }
}

export function featuredPricing(): PricedTld[] {
  return FEATURED_TLDS.map(priceTld)
}
