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

/** A registry holds a domain at most ten years ahead, so no term is longer. */
export const MAX_TERM_YEARS = 10

/** A number of years bought at once, and what it costs the customer, in kobo. */
export type Term = { years: number; priceKobo: number }

export type TldPricing = {
  tld: string
  isCountryCode: boolean
  /** The shortest and longest registration sold: the first and last of `registerPeriods`. */
  minPeriod: number
  maxPeriod: number
  /**
   * Years a registration may be bought for, ascending. Most extensions sell
   * every year from 1 to 10; some registries sell only blocks — .ai 2, 4, 6,
   * 8 or 10 years — and a period not listed here cannot be bought.
   */
  registerPeriods: number[]
  /** Years a renewal may be bought for, ascending. */
  renewPeriods: number[]
  redemptionDays: number
  requiresExtraFields: boolean
  /** One year's registration price. Not buyable alone where the first term is longer. */
  registration: Price
  /** One year's renewal price. Not buyable alone where renewals come in blocks. */
  renewal: Price
  transfer: Price | null
  /** The shortest registration and its price: the least anyone pays for this extension. */
  firstTerm: Term
  /** The shortest renewal and its price — the renewal shown beside every price (N8). */
  renewalTerm: Term
  /** True when renewal costs more than the first year. */
  renewalIsHigher: boolean
}

export type TldRecord = TldCost & {
  minPeriod: number
  maxPeriod: number
  /**
   * Years the catalogue sells a registration and a renewal for (migration
   * 37). Null or absent on a row synced before then, which means what it
   * always meant: every year from `minPeriod` to `maxPeriod`.
   */
  registerPeriods?: readonly number[] | null
  renewPeriods?: readonly number[] | null
  redemptionDays: number
  requiresExtraFields: boolean
}

/** Every whole year from `min` to `max`, within what a registry sells. */
export function yearsBetween(min: number, max: number): number[] {
  const years: number[] = []
  for (let year = Math.max(1, min); year <= Math.min(max, MAX_TERM_YEARS); year += 1) {
    years.push(year)
  }
  return years
}

/** Whole years a registry could sell, once each, ascending. */
function termYears(periods: readonly number[]): number[] {
  return [
    ...new Set(
      periods.filter((year) => Number.isInteger(year) && year >= 1 && year <= MAX_TERM_YEARS),
    ),
  ].sort((a, b) => a - b)
}

/**
 * The periods an extension is sold for. A catalogue row that lists none
 * (synced before migration 37) sells every year from its minimum to its
 * maximum, as it always did; one that lists them sells exactly those — an
 * empty list sells nothing, never a guess.
 */
export function soldPeriods(record: {
  minPeriod: number
  maxPeriod: number
  registerPeriods?: readonly number[] | null
  renewPeriods?: readonly number[] | null
}): { registerPeriods: number[]; renewPeriods: number[] } {
  const every = yearsBetween(record.minPeriod, record.maxPeriod)
  return {
    registerPeriods: record.registerPeriods ? termYears(record.registerPeriods) : every,
    renewPeriods: record.renewPeriods ? termYears(record.renewPeriods) : every,
  }
}

export function priceCatalogue(tlds: TldRecord[], inputs: PricingInputs): TldPricing[] {
  const out: TldPricing[] = []

  for (const tld of tlds) {
    const registration = priceFor(tld, 'registration', inputs)
    const renewal = priceFor(tld, 'renewal', inputs)
    if (!registration || !renewal) continue
    // An extension with no period we can sell has no price we can state (N9b).
    const { registerPeriods, renewPeriods } = soldPeriods(tld)
    const first = registerPeriods[0]
    const renewFirst = renewPeriods[0]
    if (first === undefined || renewFirst === undefined) continue

    const terms = { registration, renewal, registerPeriods, renewPeriods }
    out.push({
      tld: tld.name,
      isCountryCode: tld.isCountryCode,
      minPeriod: first,
      maxPeriod: registerPeriods.at(-1) ?? first,
      registerPeriods,
      renewPeriods,
      redemptionDays: tld.redemptionDays,
      requiresExtraFields: tld.requiresExtraFields,
      registration,
      renewal,
      transfer: priceFor(tld, 'transfer', inputs),
      firstTerm: { years: first, priceKobo: periodTotalKobo(terms, first) },
      renewalTerm: { years: renewFirst, priceKobo: renewalTotalKobo(terms, renewFirst) },
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

/**
 * The price of registering for `years` (FR-C2): the first term at the
 * registration price for each of its years, each later year at the renewal
 * price. The first term is one year for most extensions, so this is the
 * first year plus renewal years; for .ai, sold from two years, it is two
 * registration years plus renewal years.
 *
 * That is how the supplier builds its own per-period matrix — checked on
 * 23 Sept 2026 against all 5,613 multi-year prices in the catalogue. The
 * catalogue sync offers a period only where the supplier's listed price for
 * it matches this rule to the cent (see apps/gateway/src/catalogue), so the
 * total is exactly the prices the customer already sees, added up, and never
 * less than what the period costs us.
 *
 * Throws for a period the extension is not sold for: it has no true price.
 */
export function periodTotalKobo(
  pricing: {
    registration: { priceKobo: number }
    renewal: { priceKobo: number }
    registerPeriods: readonly number[]
  },
  years: number,
): number {
  if (!Number.isInteger(years) || years < 1) throw new RangeError(`Invalid period: ${years}`)
  if (!pricing.registerPeriods.includes(years)) {
    throw new RangeError(`Not a registration period this extension sells: ${years}`)
  }
  const first = pricing.registerPeriods[0] ?? years
  return pricing.registration.priceKobo * first + pricing.renewal.priceKobo * (years - first)
}

/**
 * The price of renewing for `years` (FR-RN1): every year at the renewal
 * price, the same figure shown beside every price we list (N8). Throws for
 * a period renewals are not sold in.
 */
export function renewalTotalKobo(
  pricing: { renewal: { priceKobo: number }; renewPeriods: readonly number[] },
  years: number,
): number {
  if (!Number.isInteger(years) || years < 1) throw new RangeError(`Invalid period: ${years}`)
  if (!pricing.renewPeriods.includes(years)) {
    throw new RangeError(`Not a renewal period this extension sells: ${years}`)
  }
  return pricing.renewal.priceKobo * years
}

/**
 * How a renewal price reads beside another price (N8): "/yr" where a renewal
 * can be one year, "every 2 years" where the registry renews only in blocks —
 * a per-year figure there would suggest a year that cannot be bought.
 */
export function renewalSuffix(years: number): string {
  return years === 1 ? '/yr' : ` every ${years} years`
}

/** "₦18,700/yr", or "₦399,600 every 2 years": a renewal term at its whole price. */
export function formatRenewal(perYearKobo: number, years: number): string {
  return `${formatNaira(perYearKobo * years)}${renewalSuffix(years)}`
}

/** VAT on an amount in kobo, rounded half-up to the kobo. */
export function vatKobo(amountKobo: number, vatPct: number): number {
  if (vatPct < 0) throw new RangeError('VAT cannot be negative')
  return Math.round((amountKobo * vatPct) / 100)
}
