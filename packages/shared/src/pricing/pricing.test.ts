import { describe, expect, it } from 'vitest'
import {
  effectiveFxRate,
  formatNaira,
  formatRenewal,
  KOBO_PER_NAIRA,
  type PricingInputs,
  periodTotalKobo,
  priceCatalogue,
  priceFor,
  renewalSuffix,
  renewalTotalKobo,
  roundUpToHundred,
  soldPeriods,
  type TldCost,
  type TldRecord,
  vatKobo,
  yearsBetween,
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
  const pricing = {
    registration: { priceKobo: 1_840_000 },
    renewal: { priceKobo: 1_870_000 },
    registerPeriods: yearsBetween(1, 10),
  }

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
  const every = yearsBetween(1, 10)

  it('charges every year at the renewal price', () => {
    expect(renewalTotalKobo({ renewal: { priceKobo: 1_860_000 }, renewPeriods: every }, 1)).toBe(
      1_860_000,
    )
    expect(renewalTotalKobo({ renewal: { priceKobo: 1_860_000 }, renewPeriods: every }, 3)).toBe(
      5_580_000,
    )
  })

  it('refuses a period that is not a whole number of years', () => {
    expect(() => renewalTotalKobo({ renewal: { priceKobo: 100 }, renewPeriods: every }, 0)).toThrow(
      RangeError,
    )
    expect(() =>
      renewalTotalKobo({ renewal: { priceKobo: 100 }, renewPeriods: every }, 1.5),
    ).toThrow(RangeError)
  })
})

/**
 * The period model (migration 37). The first test is the promise that it
 * changed nothing for extensions sold a year at a time: the old formulas are
 * copied here as they were, and every price must match them to the kobo.
 */
describe('one-year extensions price exactly as before', () => {
  const legacyPeriodTotal = (registration: number, renewal: number, years: number) =>
    registration + renewal * (years - 1)
  const legacyRenewalTotal = (renewal: number, years: number) => renewal * years

  const records: TldRecord[] = [
    {
      ...tld({ name: 'com', registerUsd: 11.31, renewUsd: 11.51, transferUsd: 10.61 }),
      minPeriod: 1,
      maxPeriod: 10,
      redemptionDays: 30,
      requiresExtraFields: false,
    },
    {
      ...tld({ name: 'org', registerUsd: 8.49, renewUsd: 13.99 }),
      minPeriod: 1,
      maxPeriod: 10,
      redemptionDays: 30,
      requiresExtraFields: false,
    },
    {
      ...tld({ name: 'co', isCountryCode: true, registerUsd: 26.5, renewUsd: 26.5 }),
      minPeriod: 1,
      maxPeriod: 5,
      redemptionDays: 30,
      requiresExtraFields: false,
    },
  ]
  // A row synced before migration 37 lists no periods; one synced after lists every year.
  const before = priceCatalogue(records, INPUTS)
  const after = priceCatalogue(
    records.map((record) => ({
      ...record,
      registerPeriods: yearsBetween(record.minPeriod, record.maxPeriod),
      renewPeriods: yearsBetween(record.minPeriod, record.maxPeriod),
    })),
    INPUTS,
  )

  it('keeps the one-year prices, cost and margin, whether or not the row lists its periods', () => {
    expect(after).toHaveLength(3)
    expect(after.map((entry) => [entry.registration, entry.renewal, entry.transfer])).toEqual(
      before.map((entry) => [entry.registration, entry.renewal, entry.transfer]),
    )
    for (const entry of [...before, ...after]) {
      expect(entry.firstTerm).toEqual({ years: 1, priceKobo: entry.registration.priceKobo })
      expect(entry.renewalTerm).toEqual({ years: 1, priceKobo: entry.renewal.priceKobo })
    }
  })

  it('charges every period what the old formulas charged', () => {
    for (const entry of [...before, ...after]) {
      expect(entry.registerPeriods).toEqual(yearsBetween(1, entry.maxPeriod))
      for (const years of entry.registerPeriods) {
        expect(periodTotalKobo(entry, years), `.${entry.tld} ${years}y`).toBe(
          legacyPeriodTotal(entry.registration.priceKobo, entry.renewal.priceKobo, years),
        )
        expect(renewalTotalKobo(entry, years), `.${entry.tld} renew ${years}y`).toBe(
          legacyRenewalTotal(entry.renewal.priceKobo, years),
        )
      }
    }
  })

  it('still earns the flat ₦3,000 on each year paid, rounded up to ₦100', () => {
    for (const entry of before) {
      const price = entry.registration.priceKobo
      expect(price % 10_000).toBe(0)
      expect(price - entry.registration.costKobo).toBeGreaterThanOrEqual(300_000)
      expect(price - entry.registration.costKobo).toBeLessThan(310_000)
    }
  })
})

/**
 * .ai, as the supplier listed it on 29 Sept 2026: register and renew in
 * blocks of 2, 4, 6, 8 or 10 years at USD 99.90 a year. The sync stores the
 * per-year rate and the periods; odd renewal years are dropped there.
 */
describe('an extension sold in multi-year blocks (.ai)', () => {
  const AI_LISTED_REGISTER: Record<number, number> = {
    2: 199.8,
    4: 399.6,
    6: 599.4,
    8: 799.2,
    10: 999,
  }
  const ai: TldRecord = {
    ...tld({ name: 'ai', isCountryCode: true, registerUsd: 99.9, renewUsd: 99.9 }),
    transferUsd: 99.9,
    minPeriod: 2,
    maxPeriod: 10,
    registerPeriods: [2, 4, 6, 8, 10],
    renewPeriods: [2, 4, 6, 8, 10],
    redemptionDays: 30,
    requiresExtraFields: false,
  }
  const [priced] = priceCatalogue([ai], INPUTS)
  if (!priced) throw new Error('.ai did not price')

  it('prices one year as any extension, without an ICANN fee (a ccTLD)', () => {
    const costKobo = Math.round(99.9 * 1335.69 * KOBO_PER_NAIRA)
    expect(priced.registration.costKobo).toBe(costKobo)
    expect(priced.registration.priceKobo).toBe(roundUpToHundred(costKobo + 300_000))
  })

  it('states the shortest term as what a customer pays at least: two years', () => {
    expect(priced.minPeriod).toBe(2)
    expect(priced.maxPeriod).toBe(10)
    expect(priced.firstTerm).toEqual({ years: 2, priceKobo: 2 * priced.registration.priceKobo })
    expect(priced.renewalTerm).toEqual({ years: 2, priceKobo: 2 * priced.renewal.priceKobo })
  })

  it('charges each period the per-year price times its years', () => {
    for (const years of [2, 4, 6, 8, 10]) {
      expect(periodTotalKobo(priced, years)).toBe(priced.registration.priceKobo * years)
      expect(renewalTotalKobo(priced, years)).toBe(priced.renewal.priceKobo * years)
    }
  })

  it('never charges below what the supplier lists for a period, and earns ₦3,000 a year paid', () => {
    for (const [years, usd] of Object.entries(AI_LISTED_REGISTER)) {
      const listedKobo = Math.round(usd * 1335.69 * KOBO_PER_NAIRA)
      const margin = periodTotalKobo(priced, Number(years)) - listedKobo
      expect(margin, `${years} years`).toBeGreaterThanOrEqual(300_000 * Number(years))
      expect(margin, `${years} years`).toBeLessThan(310_000 * Number(years))
    }
  })

  it('refuses a period the registry does not sell', () => {
    for (const years of [1, 3, 5, 7, 9]) {
      expect(() => periodTotalKobo(priced, years), `register ${years}`).toThrow(RangeError)
      expect(() => renewalTotalKobo(priced, years), `renew ${years}`).toThrow(RangeError)
    }
  })

  it('may renew a year at a time where the first term is longer (.as)', () => {
    const [as] = priceCatalogue(
      [{ ...ai, name: 'as', registerPeriods: [2], renewPeriods: yearsBetween(1, 10) }],
      INPUTS,
    )
    expect(as?.firstTerm.years).toBe(2)
    expect(as?.maxPeriod).toBe(2)
    expect(as?.renewalTerm).toEqual({ years: 1, priceKobo: as?.renewal.priceKobo })
  })
})

describe('soldPeriods', () => {
  it('reads a row without periods as every year from its minimum to its maximum', () => {
    expect(soldPeriods({ minPeriod: 1, maxPeriod: 5 })).toEqual({
      registerPeriods: [1, 2, 3, 4, 5],
      renewPeriods: [1, 2, 3, 4, 5],
    })
    expect(soldPeriods({ minPeriod: 1, maxPeriod: 10, registerPeriods: null })).toEqual(
      soldPeriods({ minPeriod: 1, maxPeriod: 10 }),
    )
  })

  it('keeps listed periods once each, in order, within ten years', () => {
    expect(
      soldPeriods({
        minPeriod: 2,
        maxPeriod: 10,
        registerPeriods: [10, 2, 4, 4, 0, 11, 2.5],
        renewPeriods: [2],
      }),
    ).toEqual({ registerPeriods: [2, 4, 10], renewPeriods: [2] })
  })

  it('never falls back to a guess for an empty list', () => {
    expect(soldPeriods({ minPeriod: 1, maxPeriod: 10, renewPeriods: [] }).renewPeriods).toEqual([])
  })

  it('leaves an extension with no period to sell out of the catalogue', () => {
    const base: TldRecord = {
      ...tld({ name: 'xx' }),
      minPeriod: 1,
      maxPeriod: 10,
      redemptionDays: 0,
      requiresExtraFields: false,
    }
    expect(priceCatalogue([{ ...base, registerPeriods: [] }], INPUTS)).toEqual([])
    expect(priceCatalogue([{ ...base, renewPeriods: [] }], INPUTS)).toEqual([])
  })
})

describe('yearsBetween', () => {
  it('counts whole years, never outside one to ten', () => {
    expect(yearsBetween(1, 3)).toEqual([1, 2, 3])
    expect(yearsBetween(0, 12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(yearsBetween(5, 4)).toEqual([])
  })
})

describe('renewal wording (N8)', () => {
  it('reads per year where a renewal can be one year', () => {
    expect(renewalSuffix(1)).toBe('/yr')
    expect(formatRenewal(1_870_000, 1)).toMatch(/^₦18,700\/yr$/)
  })

  it('names the block, at its whole price, where renewals come in blocks', () => {
    expect(renewalSuffix(2)).toBe(' every 2 years')
    expect(formatRenewal(13_650_000, 2)).toMatch(/^₦273,000 every 2 years$/)
  })
})
