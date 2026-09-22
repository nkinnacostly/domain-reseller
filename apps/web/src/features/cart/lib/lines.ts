import { periodTotalKobo, type TldPricing } from '@dr/shared'

/**
 * Pricing a cart line and deciding whether its quote still stands (FR-C2, FR-C4).
 * Pure: the caller supplies the catalogue and the clock.
 */

export const MAX_CART_ITEMS = 50

export type Quote = { totalKobo: number; renewalKobo: number }

export type StoredLine = {
  id: string
  domain: string
  tld: string
  periodYears: number
  privacy: boolean
  autoRenew: boolean
  quotedTotalKobo: number
  quotedRenewalKobo: number
  quotedAt: string
}

/**
 * - `held`      — inside the lock window: the quoted price stands, whatever moved
 * - `current`   — the window has passed but the price has not changed
 * - `changed`   — the window has passed and the price moved; needs acknowledgement
 * - `unavailable` — we no longer sell this extension (paused or dropped)
 */
export type LineStatus = 'held' | 'current' | 'changed' | 'unavailable'

export type PricedLine = StoredLine & {
  status: LineStatus
  /** What the customer pays for this line now: the held quote, or today's price. */
  payableKobo: number
  renewalKobo: number
  /** Today's price, for showing the difference on a changed line. */
  currentKobo: number | null
  minPeriod: number
  maxPeriod: number
  /** Generic extensions carry the ICANN fee, already inside the price (FR-C5). */
  includesIcannFee: boolean
  /** Contact privacy is free, and offered on generic extensions (FR-C3). */
  privacyOffered: boolean
  heldUntil: string | null
}

export function quoteFor(pricing: TldPricing, years: number): Quote {
  return { totalKobo: periodTotalKobo(pricing, years), renewalKobo: pricing.renewal.priceKobo }
}

/** Keeps a period inside what the registry allows. */
export function clampPeriod(
  years: number,
  pricing: Pick<TldPricing, 'minPeriod' | 'maxPeriod'>,
): number {
  return Math.min(Math.max(Math.trunc(years), pricing.minPeriod, 1), pricing.maxPeriod)
}

export function priceLine(
  line: StoredLine,
  pricing: TldPricing | undefined,
  now: Date,
  lockMinutes: number,
): PricedLine {
  const heldUntil = new Date(new Date(line.quotedAt).getTime() + lockMinutes * 60_000)

  if (!pricing) {
    return {
      ...line,
      status: 'unavailable',
      payableKobo: 0,
      renewalKobo: line.quotedRenewalKobo,
      currentKobo: null,
      minPeriod: 1,
      maxPeriod: line.periodYears,
      includesIcannFee: false,
      privacyOffered: false,
      heldUntil: null,
    }
  }

  const current = quoteFor(pricing, line.periodYears)
  const base = {
    ...line,
    currentKobo: current.totalKobo,
    minPeriod: pricing.minPeriod,
    maxPeriod: pricing.maxPeriod,
    includesIcannFee: !pricing.isCountryCode,
    privacyOffered: !pricing.isCountryCode,
  }

  if (now < heldUntil) {
    return {
      ...base,
      status: 'held',
      payableKobo: line.quotedTotalKobo,
      renewalKobo: line.quotedRenewalKobo,
      heldUntil: heldUntil.toISOString(),
    }
  }

  const unchanged =
    current.totalKobo === line.quotedTotalKobo && current.renewalKobo === line.quotedRenewalKobo
  return {
    ...base,
    status: unchanged ? 'current' : 'changed',
    payableKobo: current.totalKobo,
    renewalKobo: current.renewalKobo,
    heldUntil: null,
  }
}

export type CartTotals = {
  subtotalKobo: number
  vatKobo: number
  totalKobo: number
  /** Lines whose price moved and must be accepted before checkout. */
  needsAcknowledgement: boolean
  /** Lines we can no longer sell, left out of the totals. */
  unavailableCount: number
}

export function cartTotals(lines: PricedLine[], vat: (amountKobo: number) => number): CartTotals {
  const payable = lines.filter((line) => line.status !== 'unavailable')
  const subtotalKobo = payable.reduce((sum, line) => sum + line.payableKobo, 0)
  const vatKobo = vat(subtotalKobo)
  return {
    subtotalKobo,
    vatKobo,
    totalKobo: subtotalKobo + vatKobo,
    needsAcknowledgement: lines.some((line) => line.status === 'changed'),
    unavailableCount: lines.length - payable.length,
  }
}
