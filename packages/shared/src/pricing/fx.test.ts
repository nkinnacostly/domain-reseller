import { describe, expect, it } from 'vitest'
import {
  crossCheckQuotes,
  DEFAULT_CROSS_CHECK_TOLERANCE_PCT,
  DEFAULT_MOVE_THRESHOLD_PCT,
  evaluateRateChange,
  type RateQuote,
} from './fx'

const quote = (source: RateQuote['source'], rate: number): RateQuote => ({
  source,
  rate,
  quotedAt: new Date(),
})

describe('crossCheckQuotes', () => {
  it('agrees when two live sources are close', () => {
    // Real figures observed from the two feeds on the same day.
    const result = crossCheckQuotes([quote('er-api', 1335.69), quote('currency-api', 1331.86)])
    expect(result.agreed).toBe(true)
    expect(result.agreed && result.rate).toBeCloseTo(1333.78, 1)
  })

  it('refuses when sources disagree beyond tolerance', () => {
    const result = crossCheckQuotes([quote('er-api', 1335), quote('currency-api', 1600)])
    expect(result.agreed).toBe(false)
    expect(!result.agreed && result.reason).toMatch(/disagree/)
  })

  /** A median means one bad feed among three cannot drag the result. */
  it('ignores an outlier when a majority agree', () => {
    const result = crossCheckQuotes(
      [quote('er-api', 1335), quote('currency-api', 1336), quote('manual', 1340)],
      10,
    )
    expect(result.agreed && result.rate).toBe(1336)
  })

  it('averages the middle pair for an even count', () => {
    const result = crossCheckQuotes([quote('er-api', 1330), quote('currency-api', 1340)])
    expect(result.agreed && result.rate).toBe(1335)
  })

  it('accepts a single source rather than blocking on it', () => {
    const result = crossCheckQuotes([quote('er-api', 1335)])
    expect(result.agreed).toBe(true)
    expect(result.agreed && result.rate).toBe(1335)
  })

  it('reports no usable quotes rather than inventing one', () => {
    expect(crossCheckQuotes([]).agreed).toBe(false)
    expect(crossCheckQuotes([quote('er-api', 0), quote('manual', -5)]).agreed).toBe(false)
  })

  it('drops an unusable quote but keeps a good one', () => {
    const result = crossCheckQuotes([quote('er-api', 1335), quote('manual', Number.NaN)])
    expect(result.agreed && result.rate).toBe(1335)
  })

  it('defaults to a 2% tolerance', () => {
    expect(DEFAULT_CROSS_CHECK_TOLERANCE_PCT).toBe(2)
  })
})

describe('evaluateRateChange', () => {
  it('accepts an ordinary daily move', () => {
    expect(evaluateRateChange(1335, 1350).action).toBe('accept')
  })

  it('accepts a move exactly at the threshold', () => {
    expect(evaluateRateChange(1000, 1050).action).toBe('accept')
  })

  it('holds a move beyond the threshold', () => {
    const decision = evaluateRateChange(1335, 1600)
    expect(decision.action).toBe('hold_for_review')
    expect(decision.action === 'hold_for_review' && decision.reason).toMatch(/19\.\d+%/)
  })

  it('holds a large fall as well as a large rise', () => {
    expect(evaluateRateChange(1500, 1200).action).toBe('hold_for_review')
  })

  it('holds the first rate, since there is nothing to compare', () => {
    expect(evaluateRateChange(null, 1335).action).toBe('hold_for_review')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p outright', (value) => {
    expect(evaluateRateChange(1335, value).action).toBe('reject')
  })

  it('defaults to a 5% threshold', () => {
    expect(DEFAULT_MOVE_THRESHOLD_PCT).toBe(5)
  })
})
