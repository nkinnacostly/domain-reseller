import { type PricingInputs, priceCatalogue, type TldRecord, vatKobo } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import {
  cartTotals,
  nearestSoldPeriod,
  priceLine,
  quoteFor,
  type StoredLine,
  sellsPeriod,
} from '../lib/lines'

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
/** .ai as the sync stores it (29 Sept 2026): $99.90 a year, in blocks of 2 to 10 years. */
const aiRecord: TldRecord = {
  ...record('ai', 99.9, 99.9, true),
  minPeriod: 2,
  registerPeriods: [2, 4, 6, 8, 10],
  renewPeriods: [2, 4, 6, 8, 10],
}
const [com, co, ai] = priceCatalogue(
  [record('com', 11.31, 11.51), record('co', 19.49, 38.99, true), aiRecord],
  INPUTS,
)
if (!com || !co || !ai) throw new Error('fixture')

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

describe('quoteFor and the periods sold (FR-C2)', () => {
  it('prices a multi-year registration as the first year plus renewals', () => {
    expect(quoteFor(co, 3).totalKobo).toBe(co.registration.priceKobo + 2 * co.renewal.priceKobo)
  })

  it('prices .ai for its two-year minimum, renewing at one year’s price for the term', () => {
    expect(quoteFor(ai, 2)).toEqual({
      totalKobo: 2 * ai.registration.priceKobo,
      renewalKobo: ai.renewal.priceKobo,
    })
    expect(quoteFor(ai, 10).totalKobo).toBe(10 * ai.registration.priceKobo)
  })

  it('has no price for a period the registry does not sell', () => {
    expect(() => quoteFor(ai, 3)).toThrow(RangeError)
    expect(() => quoteFor(ai, 1)).toThrow(RangeError)
    expect(sellsPeriod(ai, 3)).toBe(false)
    expect(sellsPeriod(ai, 4)).toBe(true)
    expect(sellsPeriod(com, 7)).toBe(true)
  })

  it('moves an unsold period up to the next one sold, never down', () => {
    expect(nearestSoldPeriod(3, ai)).toBe(4)
    expect(nearestSoldPeriod(1, ai)).toBe(2)
    expect(nearestSoldPeriod(11, ai)).toBe(10)
  })
})

describe('priceLine — a period the registry stopped selling (FR-C2, FR-C4)', () => {
  const aiLine = (overrides: Partial<StoredLine> = {}) =>
    line({
      domain: 'getpaid.ai',
      tld: 'ai',
      periodYears: 3,
      quotedTotalKobo: 3 * ai.registration.priceKobo,
      quotedRenewalKobo: ai.renewal.priceKobo,
      ...overrides,
    })

  it('moves the line to the next period sold and asks for the new price, even inside the lock', () => {
    const priced = priceLine(aiLine(), ai, at(1), LOCK)
    expect(priced).toMatchObject({
      status: 'changed',
      periodYears: 4,
      unsoldYears: 3,
      payableKobo: 4 * ai.registration.priceKobo,
      quotedTotalKobo: 3 * ai.registration.priceKobo,
      heldUntil: null,
    })
  })

  it('holds a sold period’s quote as any other, and says which terms it sells', () => {
    const priced = priceLine(
      aiLine({ periodYears: 2, quotedTotalKobo: 2 * ai.registration.priceKobo }),
      ai,
      at(1),
      LOCK,
    )
    expect(priced).toMatchObject({
      status: 'held',
      periodYears: 2,
      unsoldYears: null,
      minPeriod: 2,
      registerPeriods: [2, 4, 6, 8, 10],
      renewYears: 2,
    })
  })

  it('renews a one-year extension a year at a time, as before', () => {
    expect(priceLine(line(), com, at(1), LOCK)).toMatchObject({ renewYears: 1, unsoldYears: null })
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
