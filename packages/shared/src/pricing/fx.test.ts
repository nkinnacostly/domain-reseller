import { describe, expect, it } from 'vitest'
import {
  costingRate,
  DEFAULT_MOVE_THRESHOLD_PCT,
  effectiveRateFrom,
  evaluateRateChange,
} from './fx'

describe('costingRate', () => {
  /**
   * We buy dollars, so we pay what the dealer sells at. Costing off `buy` or
   * the midpoint would understate cost on every domain we sell.
   */
  it('uses the dealer sell rate, not buy and not the midpoint', () => {
    expect(costingRate({ buy: 1545, sell: 1555 })).toBe(1555)
  })

  it('rejects a non-positive sell rate', () => {
    expect(() => costingRate({ buy: 0, sell: 0 })).toThrow(RangeError)
  })

  it('rejects an inverted spread, which means the provider changed shape', () => {
    expect(() => costingRate({ buy: 1600, sell: 1500 })).toThrow(/inverted/)
  })

  it('accepts a zero spread', () => {
    expect(costingRate({ buy: 1500, sell: 1500 })).toBe(1500)
  })
})

describe('evaluateRateChange', () => {
  it('accepts an ordinary daily move', () => {
    const decision = evaluateRateChange(1500, 1530)
    expect(decision.action).toBe('accept')
    expect(decision.action === 'accept' && decision.movePct).toBeCloseTo(2, 5)
  })

  it('accepts a move exactly at the threshold', () => {
    expect(evaluateRateChange(1000, 1050).action).toBe('accept')
  })

  /** A decimal slip or a bad feed must not silently reprice the catalogue. */
  it('holds a move beyond the threshold for review', () => {
    const decision = evaluateRateChange(1500, 1700)
    expect(decision.action).toBe('hold_for_review')
    expect(decision.action === 'hold_for_review' && decision.reason).toMatch(/13\.3%/)
  })

  it('holds a large fall as well as a large rise', () => {
    expect(evaluateRateChange(1500, 1200).action).toBe('hold_for_review')
  })

  it('holds the very first rate, since there is nothing to compare', () => {
    const decision = evaluateRateChange(null, 1550)
    expect(decision.action).toBe('hold_for_review')
    expect(decision.action === 'hold_for_review' && decision.reason).toMatch(/First rate/)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p outright', (value) => {
    expect(evaluateRateChange(1500, value).action).toBe('reject')
  })

  it('honours a custom threshold', () => {
    expect(evaluateRateChange(1500, 1530, 1).action).toBe('hold_for_review')
    expect(evaluateRateChange(1500, 1530, 10).action).toBe('accept')
  })

  it('defaults to a 5% threshold', () => {
    expect(DEFAULT_MOVE_THRESHOLD_PCT).toBe(5)
  })
})

describe('effectiveRateFrom', () => {
  it('applies the buffer on top of the costing rate', () => {
    expect(
      effectiveRateFrom({
        costingRate: 1500,
        bufferPct: 4,
        source: 'aboki-parallel',
        effectiveFrom: new Date(),
      }),
    ).toBe(1560)
  })
})
