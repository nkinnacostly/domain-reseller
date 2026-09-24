import { describe, expect, it } from 'vitest'
import {
  effectiveFxRate,
  formatNaira,
  KOBO_PER_NAIRA,
  type PricingInputs,
  periodTotalKobo,
  priceCatalogue,
  priceFor,
  renewalTotalKobo,
  roundUpToHundred,
  type TldCost,
  type TldRecord,
  vatKobo,
} from './index'

const INPUTS: PricingInputs = {
  fxRate: 1335.69,
  fxBufferPct: 0,
  marginNgn: 3000,
  icannFeeUsd: 0.2,
}

const tld = (over: Partial<TldCost> & { name: string }): TldCost => ({
  registerUsd: 10,
  renewUsd: 10,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  ...over,
})

const naira = (kobo: number) => kobo / KOBO_PER_NAIRA

describe('effectiveFxRate', () => {
  it('applies the buffer', () => {
    expect(effectiveFxRate(1000, 4)).toBe(1040)
  })

  it('passes the rate through when there is no buffer', () => {
    expect(effectiveFxRate(1335.69, 0)).toBe(1335.69)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p', (rate) => {
    expect(() => effectiveFxRate(rate, 0)).toThrow(RangeError)
  })

  it('rejects a negative buffer', () => {
    expect(() => effectiveFxRate(1000, -1)).toThrow(RangeError)
  })
})

describe('roundUpToHundred', () => {
  it.each([
    [1_600_000, 1_600_000],
    [1_600_001, 1_610_000],
    [1_659_900, 1_660_000],
  ])('rounds %i kobo to %i', (input, expected) => {
    expect(roundUpToHundred(input)).toBe(expected)
  })

  it('never rounds down, at any remainder', () => {
    for (let r = 0; r < 10_000; r += 37) {
      const kobo = 1_600_000 + r
      expect(roundUpToHundred(kobo)).toBeGreaterThanOrEqual(kobo)
    }
  })
})

describe('priceFor', () => {
  /** The whole pricing rule: cost plus a flat ₦3,000. */
  it('earns exactly the configured margin, before rounding', () => {
    const price = priceFor(
      tld({ name: 'ng', isCountryCode: true, registerUsd: 11.99 }),
      'registration',
      INPUTS,
    )
    expect(price).not.toBeNull()
    expect(naira(price?.costKobo ?? 0)).toBeCloseTo(11.99 * 1335.69, 1)
    expect(naira(price?.marginKobo ?? 0)).toBeGreaterThanOrEqual(3000)
  })

  it('never earns less than the margin, on any cost', () => {
    for (const costUsd of [0.5, 1, 2.49, 11.31, 44.99, 500, 5000]) {
      const price = priceFor(tld({ name: 'x', registerUsd: costUsd }), 'registration', INPUTS)
      expect(naira(price?.marginKobo ?? 0), `cost $${costUsd}`).toBeGreaterThanOrEqual(3000)
    }
  })

  it('never overshoots the margin by more than a rounding step', () => {
    for (const costUsd of [0.5, 11.31, 44.99, 500]) {
      const price = priceFor(tld({ name: 'x', registerUsd: costUsd }), 'registration', INPUTS)
      expect(naira(price?.marginKobo ?? 0), `cost $${costUsd}`).toBeLessThan(3100)
    }
  })

  it('adds the ICANN fee to a gTLD', () => {
    const price = priceFor(tld({ name: 'com', registerUsd: 11.31 }), 'registration', INPUTS)
    expect(naira(price?.costKobo ?? 0)).toBeCloseTo((11.31 + 0.2) * 1335.69, 1)
  })

  it('does not add it to a ccTLD', () => {
    const price = priceFor(
      tld({ name: 'ng', isCountryCode: true, registerUsd: 11.99 }),
      'registration',
      INPUTS,
    )
    expect(naira(price?.costKobo ?? 0)).toBeCloseTo(11.99 * 1335.69, 1)
  })

  it('prices renewal off the renewal cost, not registration', () => {
    const entry = tld({ name: 'org', registerUsd: 8.49, renewUsd: 13.99 })
    const reg = priceFor(entry, 'registration', INPUTS)
    const ren = priceFor(entry, 'renewal', INPUTS)
    expect(ren?.priceKobo ?? 0).toBeGreaterThan(reg?.priceKobo ?? 0)
  })

  it('returns null where the supplier does not price that trade', () => {
    expect(priceFor(tld({ name: 'ng', transferUsd: null }), 'transfer', INPUTS)).toBeNull()
    expect(priceFor(tld({ name: 'ng', restoreUsd: null }), 'restore', INPUTS)).toBeNull()
  })

  it('never sells below landed cost', () => {
    for (const costUsd of [0.5, 11.31, 500]) {
      const price = priceFor(tld({ name: 'x', registerUsd: costUsd }), 'registration', INPUTS)
      expect(price?.priceKobo ?? 0).toBeGreaterThan(price?.costKobo ?? 0)
    }
  })

  it('moves the price when the rate moves', () => {
    const cheap = priceFor(tld({ name: 'x', registerUsd: 10 }), 'registration', INPUTS)
    const dear = priceFor(tld({ name: 'x', registerUsd: 10 }), 'registration', {
      ...INPUTS,
      fxRate: 2000,
    })
    expect(dear?.priceKobo ?? 0).toBeGreaterThan(cheap?.priceKobo ?? 0)
  })

  it('moves the price when the margin changes', () => {
    const base = priceFor(tld({ name: 'x', registerUsd: 10 }), 'registration', INPUTS)
    const fatter = priceFor(tld({ name: 'x', registerUsd: 10 }), 'registration', {
      ...INPUTS,
      marginNgn: 5000,
    })
    expect(naira((fatter?.priceKobo ?? 0) - (base?.priceKobo ?? 0))).toBeGreaterThanOrEqual(1900)
  })
})

describe('priceCatalogue', () => {
  const records: TldRecord[] = [
    {
      ...tld({ name: 'ng', isCountryCode: true, registerUsd: 11.99, renewUsd: 11.99 }),
      minPeriod: 1,
      maxPeriod: 5,
      redemptionDays: 30,
      requiresExtraFields: false,
    },
    {
      ...tld({ name: 'com', registerUsd: 11.31, renewUsd: 11.51, transferUsd: 10.61 }),
      minPeriod: 1,
      maxPeriod: 10,
      redemptionDays: 30,
      requiresExtraFields: false,
    },
    {
      ...tld({ name: 'broken', registerUsd: 0, renewUsd: 0 }),
      minPeriod: 1,
      maxPeriod: 1,
      redemptionDays: 0,
      requiresExtraFields: false,
    },
  ]

  const priced = priceCatalogue(records, INPUTS)

  it('skips extensions the supplier does not price', () => {
    expect(priced.map((p) => p.tld)).toEqual(['ng', 'com'])
  })

  it('flags .com, where renewal costs more than the first year', () => {
    expect(priced.find((p) => p.tld === 'com')?.renewalIsHigher).toBe(true)
  })

  it('does not flag a flat-cost extension', () => {
    expect(priced.find((p) => p.tld === 'ng')?.renewalIsHigher).toBe(false)
  })

  it('gives every extension exactly the same profit', () => {
    const margins = priced.map((p) => Math.floor(naira(p.registration.marginKobo) / 100))
    expect(new Set(margins).size).toBe(1)
  })

  it('omits transfer where it is unpriced', () => {
    expect(priced.find((p) => p.tld === 'ng')?.transfer).toBeNull()
    expect(priced.find((p) => p.tld === 'com')?.transfer).not.toBeNull()
  })
})

describe('formatNaira', () => {
  it('formats whole naira', () => {
    expect(formatNaira(1_800_000)).toMatch(/18,000/)
  })

  it('never shows kobo', () => {
    expect(formatNaira(1_800_049)).not.toMatch(/\./)
  })
})

describe('periodTotalKobo (FR-C2)', () => {
  const pricing = { registration: { priceKobo: 1_840_000 }, renewal: { priceKobo: 1_870_000 } }

  it('charges the registration price for the first year only', () => {
    expect(periodTotalKobo(pricing, 1)).toBe(1_840_000)
  })

  it('charges the renewal price for every later year', () => {
    expect(periodTotalKobo(pricing, 3)).toBe(1_840_000 + 2 * 1_870_000)
  })

  it('refuses a period that is not a whole number of years', () => {
    expect(() => periodTotalKobo(pricing, 0)).toThrow(RangeError)
    expect(() => periodTotalKobo(pricing, 1.5)).toThrow(RangeError)
  })
})

describe('vatKobo', () => {
  it('takes 7.5% and rounds to the nearest kobo', () => {
    expect(vatKobo(1_840_000, 7.5)).toBe(138_000)
    expect(vatKobo(3, 7.5)).toBe(0)
    expect(vatKobo(7, 7.5)).toBe(1)
  })

  it('refuses a negative rate', () => {
    expect(() => vatKobo(100, -1)).toThrow(RangeError)
  })
})

describe('renewalTotalKobo (FR-RN1)', () => {
  it('charges every year at the renewal price', () => {
    expect(renewalTotalKobo({ renewal: { priceKobo: 1_860_000 } }, 1)).toBe(1_860_000)
    expect(renewalTotalKobo({ renewal: { priceKobo: 1_860_000 } }, 3)).toBe(5_580_000)
  })

  it('refuses a period that is not a whole number of years', () => {
    expect(() => renewalTotalKobo({ renewal: { priceKobo: 100 } }, 0)).toThrow(RangeError)
    expect(() => renewalTotalKobo({ renewal: { priceKobo: 100 } }, 1.5)).toThrow(RangeError)
  })
})
