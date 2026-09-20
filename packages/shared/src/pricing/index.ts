/**
 * Pricing.
 *
 * Every input comes from the database — wholesale cost from the synced
 * catalogue, the exchange rate from the FX feed, margin and fees from
 * pricing settings. Nothing here carries a hardcoded number.
 *
 * Money is handled in integer minor units (kobo). Never floats.
 */

export const KOBO_PER_NAIRA = 100

export type TradeKind = 'registration' | 'renewal' | 'transfer' | 'restore'

/** Wholesale costs for one extension, in USD, as the supplier quotes them. */
export type TldCost = {
  name: string
  registerUsd: number
  renewUsd: number
  transferUsd: number | null
  restoreUsd: number | null
  isCountryCode: boolean
}

/** Everything needed to turn a USD cost into a naira price. */
export type PricingInputs = {
  /** Naira per dollar, before the buffer. */
  fxRate: number
  /** Percentage added to the rate to cover settlement lag. */
  fxBufferPct: number
  /** Flat profit per domain, in naira. */
  marginNgn: number
  /** ICANN transaction fee per year, in USD. gTLDs only. */
  icannFeeUsd: number
}

export type Price = {
  tld: string
  kind: TradeKind
  /** Landed wholesale cost including any ICANN fee, in kobo. */
  costKobo: number
  /** What the customer pays, in kobo. */
  priceKobo: number
  /** Profit, in kobo. At least the configured margin. */
  marginKobo: number
}

export function effectiveFxRate(rate: number, bufferPct: number): number {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError('FX rate must be positive')
  if (!Number.isFinite(bufferPct) || bufferPct < 0) {
    throw new RangeError('FX buffer cannot be negative')
  }
  return rate * (1 + bufferPct / 100)
}

/**
 * Round up to the next ₦100.
 *
 * Only ever upward, so the configured margin is a floor rather than a target:
 * rounding down would quietly sell below it.
 */
export function roundUpToHundred(kobo: number): number {
  return Math.ceil(kobo / (100 * KOBO_PER_NAIRA)) * 100 * KOBO_PER_NAIRA
}

function costUsdFor(tld: TldCost, kind: TradeKind): number | null {
  switch (kind) {
    case 'registration':
      return tld.registerUsd
    case 'renewal':
      return tld.renewUsd
    case 'transfer':
      return tld.transferUsd
    case 'restore':
      return tld.restoreUsd
  }
}

export function priceFor(tld: TldCost, kind: TradeKind, inputs: PricingInputs): Price | null {
  const costUsd = costUsdFor(tld, kind)
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= 0) return null

  const rate = effectiveFxRate(inputs.fxRate, inputs.fxBufferPct)
  // ccTLDs such as .ng carry no ICANN fee.
  const icannUsd = tld.isCountryCode ? 0 : inputs.icannFeeUsd

  const costKobo = Math.round((costUsd + icannUsd) * rate * KOBO_PER_NAIRA)
  const priceKobo = roundUpToHundred(costKobo + inputs.marginNgn * KOBO_PER_NAIRA)

  return { tld: tld.name, kind, costKobo, priceKobo, marginKobo: priceKobo - costKobo }
}

export type TldPricing = {
  tld: string
  isCountryCode: boolean
  minPeriod: number
  maxPeriod: number
  redemptionDays: number
  requiresExtraFields: boolean
  registration: Price
  renewal: Price
  transfer: Price | null
  /** True when renewal costs more than the first year. */
  renewalIsHigher: boolean
}

export type TldRecord = TldCost & {
  minPeriod: number
  maxPeriod: number
  redemptionDays: number
  requiresExtraFields: boolean
}

export function priceCatalogue(tlds: TldRecord[], inputs: PricingInputs): TldPricing[] {
  const out: TldPricing[] = []

  for (const tld of tlds) {
    const registration = priceFor(tld, 'registration', inputs)
    const renewal = priceFor(tld, 'renewal', inputs)
    if (!registration || !renewal) continue

    out.push({
      tld: tld.name,
      isCountryCode: tld.isCountryCode,
      minPeriod: tld.minPeriod,
      maxPeriod: tld.maxPeriod,
      redemptionDays: tld.redemptionDays,
      requiresExtraFields: tld.requiresExtraFields,
      registration,
      renewal,
      transfer: priceFor(tld, 'transfer', inputs),
      renewalIsHigher: renewal.priceKobo > registration.priceKobo,
    })
  }

  return out
}

const NGN = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export function formatNaira(kobo: number): string {
  return NGN.format(kobo / KOBO_PER_NAIRA)
}
