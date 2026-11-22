import { describe, expect, it } from 'vitest'
import { balanceUsdFrom } from './balance'

describe('balanceUsdFrom', () => {
  it('reads a balance sent as a number or a string, zero included', () => {
    expect(balanceUsdFrom({ OperationResult: 'SUCCESS', Balance: '152.40' })).toBe(152.4)
    expect(balanceUsdFrom({ OperationResult: 'SUCCESS', Balance: 22.14 })).toBe(22.14)
    expect(balanceUsdFrom({ OperationResult: 'SUCCESS', Balance: '0.00' })).toBe(0)
    expect(balanceUsdFrom({ OperationResult: 'SUCCESS', Balance: 0 })).toBe(0)
  })

  it('never reads a blank or missing figure as an empty float', () => {
    for (const Balance of [null, undefined, '', '  ', 'n/a', '12,40', Number.NaN, {}, []]) {
      expect(balanceUsdFrom({ OperationResult: 'SUCCESS', Balance }), String(Balance)).toBeNull()
    }
  })

  it('reads nothing from an answer that did not succeed', () => {
    expect(balanceUsdFrom({ OperationResult: 'FAILED', Balance: '22.14' })).toBeNull()
    expect(balanceUsdFrom({ Balance: '22.14' })).toBeNull()
  })
})
