/**
 * Retail pricing. PRD §8.3.
 *
 * Money is handled in integer minor units (kobo) internally. Never use floats
 * for money arithmetic — compute in kobo, format at the edge.
 */

export const KOBO_PER_NAIRA = 100

/** ICANN transaction fee: USD 0.20 per year, gTLDs only. Raised from 0.18 on 2025-07-01. */
export const ICANN_FEE_USD_PER_YEAR = 0.2

export const VAT_RATE = 0.075

export type TradeType = 'registration' | 'renewal' | 'transfer' | 'restore'

export type PriceInput = {
  /** Wholesale cost from the supplier, in USD, for the whole period. */
  supplierCostUsd: number
  /** Registration period in years. */
  periodYears: number
  /** True for gTLDs (.com, .net, .org). False for ccTLDs (.ng, .co, .ai). */
  icannFeeApplies: boolean
  /** NGN per USD, mid-market. */
  fxMidRate: number
  /** Buffer applied on top of the mid rate to absorb intraday movement, e.g. 4 for 4%. */
  fxBufferPct: number
  /** Gross margin for this TLD and trade type, e.g. 22 for 22%. */
  marginPct: number
  /** Flat markup in naira added after margin. */
  fixedMarkupNgn?: number
  /** Overrides the computed price entirely (merchandised loss-leaders, promos). */
  manualOverrideNgn?: number
}

export type PriceBreakdown = {
  supplierCostKobo: number
  icannFeeKobo: number
  subtotalKobo: number
  vatKobo: number
  totalKobo: number
  effectiveFxRate: number
}

function toKobo(naira: number): number {
  return Math.round(naira * KOBO_PER_NAIRA)
}

/**
 * Round up to a price that looks deliberate rather than converted.
 * ₦17,214 → ₦17,500 · ₦17,640 → ₦17,900 · ₦17,950 → ₦18,000 (PRD FR-PRICE-4).
 */
export function roundToPsychological(kobo: number): number {
  const naira = Math.ceil(kobo / KOBO_PER_NAIRA)
  const thousands = Math.floor(naira / 1000)
  const remainder = naira - thousands * 1000

  // The ladder of acceptable endings within a thousand, then the next thousand.
  // Rounding must never go DOWN — the price would fall through the margin floor.
  if (remainder === 0) return toKobo(naira)
  if (remainder <= 500) return toKobo(thousands * 1000 + 500)
  if (remainder <= 900) return toKobo(thousands * 1000 + 900)
  return toKobo((thousands + 1) * 1000)
}

export function effectiveFxRate(midRate: number, bufferPct: number): number {
  if (midRate <= 0) throw new RangeError('FX mid rate must be positive')
  if (bufferPct < 0) throw new RangeError('FX buffer cannot be negative')
  return midRate * (1 + bufferPct / 100)
}

export function computePrice(input: PriceInput): PriceBreakdown {
  const {
    supplierCostUsd,
    periodYears,
    icannFeeApplies,
    fxMidRate,
    fxBufferPct,
    marginPct,
    fixedMarkupNgn = 0,
    manualOverrideNgn,
  } = input

  if (periodYears < 1) throw new RangeError('Period must be at least one year')
  if (supplierCostUsd < 0) throw new RangeError('Supplier cost cannot be negative')

  const rate = effectiveFxRate(fxMidRate, fxBufferPct)

  const icannFeeUsd = icannFeeApplies ? ICANN_FEE_USD_PER_YEAR * periodYears : 0
  const supplierCostKobo = toKobo(supplierCostUsd * rate)
  const icannFeeKobo = toKobo(icannFeeUsd * rate)

  let subtotalKobo: number
  if (manualOverrideNgn !== undefined) {
    subtotalKobo = toKobo(manualOverrideNgn)
  } else {
    const withMargin = (supplierCostKobo + icannFeeKobo) * (1 + marginPct / 100)
    subtotalKobo = roundToPsychological(withMargin + toKobo(fixedMarkupNgn))
  }

  const vatKobo = Math.round(subtotalKobo * VAT_RATE)

  return {
    supplierCostKobo,
    icannFeeKobo,
    subtotalKobo,
    vatKobo,
    totalKobo: subtotalKobo + vatKobo,
    effectiveFxRate: rate,
  }
}

/**
 * Premium domains bypass the margin table — registry premiums range from
 * USD 50 to USD 50,000, so a percentage alone is unusable (PRD FR-PRICE-5).
 */
export function computePremiumPrice(input: {
  supplierCostUsd: number
  fxMidRate: number
  fxBufferPct: number
  markupPct: number
  minMarkupNgn: number
  maxMarkupNgn: number
}): PriceBreakdown {
  const rate = effectiveFxRate(input.fxMidRate, input.fxBufferPct)
  const supplierCostKobo = toKobo(input.supplierCostUsd * rate)

  const rawMarkup = supplierCostKobo * (input.markupPct / 100)
  const markupKobo = Math.min(
    Math.max(rawMarkup, toKobo(input.minMarkupNgn)),
    toKobo(input.maxMarkupNgn),
  )

  const subtotalKobo = roundToPsychological(supplierCostKobo + markupKobo)
  const vatKobo = Math.round(subtotalKobo * VAT_RATE)

  return {
    supplierCostKobo,
    icannFeeKobo: 0,
    subtotalKobo,
    vatKobo,
    totalKobo: subtotalKobo + vatKobo,
    effectiveFxRate: rate,
  }
}

const NGN_FORMATTER = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

export function formatNaira(kobo: number): string {
  return NGN_FORMATTER.format(kobo / KOBO_PER_NAIRA)
}
