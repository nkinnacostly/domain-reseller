import { describe, expect, it } from 'vitest'
import { renewalTermColumn, unsoldPeriods } from '../lib/periods'

const EVERY_YEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const line = (over: Record<string, unknown> = {}) => ({
  domain: 'getpaid.com',
  periodYears: 1,
  registerPeriods: EVERY_YEAR,
  unsoldYears: null as number | null,
  status: 'current',
  ...over,
})

describe('unsoldPeriods (FR-C2, N9b)', () => {
  it('passes a period the registry sells', () => {
    expect(unsoldPeriods([line(), line({ periodYears: 7 })])).toEqual([])
    expect(
      unsoldPeriods([line({ domain: 'getpaid.ai', periodYears: 2, registerPeriods: [2, 4] })]),
    ).toEqual([])
  })

  it('stops a period the registry does not sell — .ai for one or three years', () => {
    const ai = (periodYears: number) =>
      line({ domain: 'getpaid.ai', periodYears, registerPeriods: [2, 4, 6, 8, 10] })
    expect(unsoldPeriods([ai(1), ai(3), ai(4)]).map((entry) => entry.periodYears)).toEqual([1, 3])
  })

  it('stops a line the cart moved off a period no longer sold, until its price is accepted', () => {
    expect(unsoldPeriods([line({ periodYears: 4, unsoldYears: 3 })])).toHaveLength(1)
  })

  it('leaves an extension we stopped selling to the cart’s own refusal', () => {
    expect(unsoldPeriods([line({ status: 'unavailable', registerPeriods: [3] })])).toEqual([])
  })
})

describe('renewalTermColumn (migration 37)', () => {
  it('writes nothing for a yearly renewal, so a line reads exactly as before', () => {
    expect(renewalTermColumn(1)).toEqual({})
  })

  it('records a block renewal’s term', () => {
    expect(renewalTermColumn(2)).toEqual({ renewal_years: 2 })
  })
})
