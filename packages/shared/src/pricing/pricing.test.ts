import { describe, expect, it } from 'vitest'
import {
  computePremiumPrice,
  computePrice,
  effectiveFxRate,
  formatNaira,
  ICANN_FEE_USD_PER_YEAR,
  roundToPsychological,
  VAT_RATE,
} from './index'

describe('effectiveFxRate', () => {
  it('applies the buffer on top of the mid rate', () => {
    expect(effectiveFxRate(1000, 4)).toBe(1040)
  })

  it('rejects a non-positive mid rate rather than producing free domains', () => {
    expect(() => effectiveFxRate(0, 4)).toThrow(RangeError)
    expect(() => effectiveFxRate(-1, 4)).toThrow(RangeError)
  })

  it('rejects a negative buffer', () => {
    expect(() => effectiveFxRate(1000, -1)).toThrow(RangeError)
  })
})

describe('roundToPsychological', () => {
  it.each([
    [1_721_400, 1_750_000], // ₦17,214 → ₦17,500
    [1_764_000, 1_790_000], // ₦17,640 → ₦17,900
    [1_000_000, 1_000_000], // exact thousands stay put
    [1_050_000, 1_050_000], // ₦10,500 is already a clean ending
  ])('rounds %i kobo to %i kobo', (input, expected) => {
    expect(roundToPsychological(input)).toBe(expected)
  })

  it('carries a remainder above 900 up to the next thousand', () => {
    // Regression: this range used to round DOWN, dropping the price through
    // the margin floor. ₦45,950 became ₦45,900.
    expect(roundToPsychological(4_595_000)).toBe(4_600_000)
    expect(roundToPsychological(4_590_100)).toBe(4_600_000)
  })

  it('never rounds down, at any remainder', () => {
    // Sweep every remainder within a thousand rather than sampling a few.
    for (let remainder = 0; remainder < 1000; remainder++) {
      const kobo = (45_000 + remainder) * 100
      expect(roundToPsychological(kobo), `remainder ${remainder}`).toBeGreaterThanOrEqual(kobo)
    }
  })
})

describe('computePrice', () => {
  const base = {
    supplierCostUsd: 8,
    periodYears: 1,
    icannFeeApplies: true,
    fxMidRate: 1550,
    fxBufferPct: 4,
    marginPct: 22,
  }

  it('produces a coherent breakdown for a one-year .com', () => {
    const result = computePrice(base)
    expect(result.effectiveFxRate).toBeCloseTo(1612, 5)
    expect(result.supplierCostKobo).toBe(Math.round(8 * 1612 * 100))
    expect(result.icannFeeKobo).toBe(Math.round(0.2 * 1612 * 100))
    expect(result.totalKobo).toBe(result.subtotalKobo + result.vatKobo)
  })

  it('charges VAT at 7.5% of the subtotal', () => {
    const result = computePrice(base)
    expect(result.vatKobo).toBe(Math.round(result.subtotalKobo * VAT_RATE))
  })

  it('omits the ICANN fee for ccTLDs', () => {
    const result = computePrice({ ...base, icannFeeApplies: false })
    expect(result.icannFeeKobo).toBe(0)
  })

  it('scales the ICANN fee by the number of years', () => {
    const oneYear = computePrice(base)
    const threeYears = computePrice({ ...base, periodYears: 3, supplierCostUsd: 24 })
    expect(threeYears.icannFeeKobo).toBeCloseTo(oneYear.icannFeeKobo * 3, -2)
  })

  it('uses USD 0.20 per year, the rate in force since 2025-07-01', () => {
    expect(ICANN_FEE_USD_PER_YEAR).toBe(0.2)
  })

  it('honours a manual override and skips psychological rounding', () => {
    const result = computePrice({ ...base, manualOverrideNgn: 9900 })
    expect(result.subtotalKobo).toBe(990_000)
  })

  it('adds a fixed naira markup on top of the margin', () => {
    const without = computePrice(base)
    const with500 = computePrice({ ...base, fixedMarkupNgn: 500 })
    expect(with500.subtotalKobo).toBeGreaterThan(without.subtotalKobo)
  })

  it('rejects a sub-one-year period', () => {
    expect(() => computePrice({ ...base, periodYears: 0 })).toThrow(RangeError)
  })

  it('rejects a negative supplier cost', () => {
    expect(() => computePrice({ ...base, supplierCostUsd: -1 })).toThrow(RangeError)
  })

  it('never sells below landed cost', () => {
    const result = computePrice(base)
    expect(result.subtotalKobo).toBeGreaterThan(result.supplierCostKobo + result.icannFeeKobo)
  })
})

describe('computePremiumPrice', () => {
  const base = {
    fxMidRate: 1550,
    fxBufferPct: 4,
    markupPct: 15,
    minMarkupNgn: 5_000,
    maxMarkupNgn: 500_000,
  }

  it('applies the markup floor on a cheap premium', () => {
    const result = computePremiumPrice({ ...base, supplierCostUsd: 50 })
    const costKobo = result.supplierCostKobo
    expect(result.subtotalKobo - costKobo).toBeGreaterThanOrEqual(500_000)
  })

  it('applies the markup ceiling on an expensive premium', () => {
    const result = computePremiumPrice({ ...base, supplierCostUsd: 50_000 })
    const costKobo = result.supplierCostKobo
    expect(result.subtotalKobo - costKobo).toBeLessThanOrEqual(50_000_000 + 90_000)
  })

  it('charges no ICANN fee line on premiums', () => {
    expect(computePremiumPrice({ ...base, supplierCostUsd: 500 }).icannFeeKobo).toBe(0)
  })
})

describe('formatNaira', () => {
  it('formats kobo as whole naira', () => {
    expect(formatNaira(1_750_000)).toMatch(/17,500/)
  })

  it('never shows fractional kobo to a user', () => {
    expect(formatNaira(1_750_049)).not.toMatch(/\./)
  })
})
