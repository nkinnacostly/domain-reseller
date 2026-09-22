import { type PricingInputs, priceCatalogue, type TldRecord, vatKobo } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { cartTotals, clampPeriod, priceLine, quoteFor, type StoredLine } from '../lib/lines'

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (
  name: string,
  register: number,
  renew: number,
  isCountryCode = false,
): TldRecord => ({
  name,
  registerUsd: register,
  renewUsd: renew,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const [com, co] = priceCatalogue(
  [record('com', 11.31, 11.51), record('co', 19.49, 38.99, true)],
  INPUTS,
)
if (!com || !co) throw new Error('fixture')

const LOCK = 30
const QUOTED_AT = '2026-09-23T10:00:00.000Z'
const at = (minutes: number) => new Date(new Date(QUOTED_AT).getTime() + minutes * 60_000)

const line = (overrides: Partial<StoredLine> = {}): StoredLine => {
  const quote = quoteFor(com, 1)
  return {
    id: 'line-1',
    domain: 'getpaid.com',
    tld: 'com',
    periodYears: 1,
    privacy: true,
    autoRenew: true,
    quotedTotalKobo: quote.totalKobo,
    quotedRenewalKobo: quote.renewalKobo,
    quotedAt: QUOTED_AT,
    ...overrides,
  }
}

describe('priceLine — the price lock (FR-C4)', () => {
  it('holds the quoted price inside the window, even if the price has moved', () => {
    const priced = priceLine(line({ quotedTotalKobo: 1_000_000 }), com, at(29), LOCK)
    expect(priced.status).toBe('held')
    expect(priced.payableKobo).toBe(1_000_000)
    expect(priced.heldUntil).toBe('2026-09-23T10:30:00.000Z')
  })

  it('asks for acknowledgement once the window has passed and the price moved', () => {
    const priced = priceLine(line({ quotedTotalKobo: 1_000_000 }), com, at(30), LOCK)
    expect(priced.status).toBe('changed')
    expect(priced.payableKobo).toBe(com.registration.priceKobo)
    expect(priced.currentKobo).toBe(com.registration.priceKobo)
  })

  it('carries on quietly when the window has passed but nothing changed', () => {
    const priced = priceLine(line(), com, at(45), LOCK)
    expect(priced.status).toBe('current')
    expect(priced.payableKobo).toBe(priced.quotedTotalKobo)
  })

  it('flags an extension we no longer sell and prices it at nothing', () => {
    const priced = priceLine(line(), undefined, at(1), LOCK)
    expect(priced.status).toBe('unavailable')
    expect(priced.payableKobo).toBe(0)
  })

  it('offers free privacy and marks the ICANN fee on generic extensions only', () => {
    expect(priceLine(line(), com, at(1), LOCK)).toMatchObject({
      includesIcannFee: true,
      privacyOffered: true,
    })
    expect(priceLine(line({ tld: 'co', domain: 'getpaid.co' }), co, at(1), LOCK)).toMatchObject({
      includesIcannFee: false,
      privacyOffered: false,
    })
  })
})

describe('quoteFor and clampPeriod (FR-C2)', () => {
  it('prices a multi-year registration as the first year plus renewals', () => {
    expect(quoteFor(co, 3).totalKobo).toBe(co.registration.priceKobo + 2 * co.renewal.priceKobo)
  })

  it('keeps a period inside what the registry allows', () => {
    const limits = { minPeriod: 2, maxPeriod: 5 }
    expect(clampPeriod(1, limits)).toBe(2)
    expect(clampPeriod(9, limits)).toBe(5)
    expect(clampPeriod(3.7, limits)).toBe(3)
  })
})

describe('cartTotals (FR-C5)', () => {
  const vat = (amount: number) => vatKobo(amount, 7.5)

  it('adds VAT on the subtotal as its own line', () => {
    const totals = cartTotals([priceLine(line(), com, at(1), LOCK)], vat)
    expect(totals.vatKobo).toBe(vatKobo(totals.subtotalKobo, 7.5))
    expect(totals.totalKobo).toBe(totals.subtotalKobo + totals.vatKobo)
  })

  it('leaves out lines we can no longer sell, and says how many', () => {
    const totals = cartTotals(
      [priceLine(line(), com, at(1), LOCK), priceLine(line({ id: 'x' }), undefined, at(1), LOCK)],
      vat,
    )
    expect(totals.subtotalKobo).toBe(com.registration.priceKobo)
    expect(totals.unavailableCount).toBe(1)
  })

  it('blocks checkout until a changed price is accepted', () => {
    const changed = priceLine(line({ quotedTotalKobo: 1 }), com, at(31), LOCK)
    expect(cartTotals([changed], vat).needsAcknowledgement).toBe(true)
  })
})
