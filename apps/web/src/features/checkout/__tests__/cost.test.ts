import { describe, expect, it } from 'vitest'
import {
  costRows,
  type LineCost,
  lineCostUsd,
  type SupplierCost,
  sslCostUsd,
  totalCents,
  wholesaleCostUsd,
} from '../lib/cost'

/**
 * What each line costs us, in integer cents (FR-C8, ADMIN-SPEC §6, D13, D24).
 * The float pre-flight checks the sum of these lines, and `order_item_costs`
 * records each one, so the two can never disagree by a cent.
 */

const COM: SupplierCost = {
  registerUsd: '11.3100',
  renewUsd: '11.5100',
  isCountryCode: false,
  firstTermYears: 1,
}
// .ai as the sync stores it: a per-year rate, sold from two years. A renewal
// rate apart from the registration rate shows which years take which.
const AI: SupplierCost = {
  registerUsd: '99.9000',
  renewUsd: '109.9000',
  isCountryCode: true,
  firstTermYears: 2,
}

describe('lineCostUsd — a registration', () => {
  it('splits the ICANN fee out, a year at a time, on a generic extension', () => {
    expect(
      lineCostUsd({ kind: 'register', tld: 'com', periodYears: 1, cost: COM }, '0.2000'),
    ).toEqual({ supplierCents: 1131, icannCents: 20 })
    // The first year at the registration rate, the next two at renewal.
    expect(
      lineCostUsd({ kind: 'register', tld: 'com', periodYears: 3, cost: COM }, '0.2000'),
    ).toEqual({ supplierCents: 1131 + 2 * 1151, icannCents: 60 })
  })

  it('costs .ai’s first term — two years — at the registration rate, later years at renewal', () => {
    expect(lineCostUsd({ kind: 'register', tld: 'ai', periodYears: 2, cost: AI }, 0.2)).toEqual({
      supplierCents: 19_980,
      icannCents: 0,
    })
    expect(lineCostUsd({ kind: 'register', tld: 'ai', periodYears: 4, cost: AI }, 0.2)).toEqual({
      supplierCents: 19_980 + 21_980,
      icannCents: 0,
    })
  })

  it('refuses a period shorter than the first term the registry sells', () => {
    expect(() =>
      lineCostUsd({ kind: 'register', tld: 'ai', periodYears: 1, cost: AI }, 0.2),
    ).toThrow(/\.ai is not sold for 1 years/)
    expect(() =>
      lineCostUsd({ kind: 'register', tld: 'com', periodYears: 0, cost: COM }, 0.2),
    ).toThrow(/not sold/)
  })
})

describe('lineCostUsd — renewals, transfers and certificates', () => {
  it('renews at the renewal rate each year, with the ICANN fee each year', () => {
    expect(
      lineCostUsd({ kind: 'renew', years: 2, renewUsd: '11.5100', isCountryCode: false }, '0.2000'),
    ).toEqual({ supplierCents: 2302, icannCents: 40 })
  })

  it('transfers at the transfer price, with the ICANN fee once', () => {
    expect(
      lineCostUsd({ kind: 'transfer', transferUsd: '10.6100', isCountryCode: false }, '0.2000'),
    ).toEqual({ supplierCents: 1061, icannCents: 20 })
    expect(lineCostUsd({ kind: 'transfer', transferUsd: 38.99, isCountryCode: true }, 0.2)).toEqual(
      { supplierCents: 3899, icannCents: 0 },
    )
  })

  it('costs a certificate at the product’s price, with no ICANN fee', () => {
    expect(lineCostUsd({ kind: 'ssl', productCode: '351', createUsd: '6.99' }, '0.2000')).toEqual({
      supplierCents: 699,
      icannCents: 0,
    })
  })

  it('refuses a certificate whose product has no cost, rather than guessing (N5b)', () => {
    for (const createUsd of [null, undefined, '0.00', 0]) {
      expect(() => lineCostUsd({ kind: 'ssl', productCode: '351', createUsd }, 0)).toThrow(
        'No supplier cost for SSL product 351',
      )
    }
  })
})

describe('lineCostUsd — money is exact (N5, D24)', () => {
  it('reads decimal text, never a float: $1.005 is 101 cents, not 100', () => {
    // As a float, 1.005 × 100 is 100.49999…, which rounds down.
    expect(
      lineCostUsd({ kind: 'ssl', productCode: 'x', createUsd: '1.005' }, 0).supplierCents,
    ).toBe(101)
  })

  it('multiplies a four-place rate by its years before rounding, once, at the cent', () => {
    // $80.155 × 2 = $160.31 — rounding each year first would make it $160.32.
    expect(
      lineCostUsd({ kind: 'renew', years: 2, renewUsd: '80.1550', isCountryCode: true }, 0)
        .supplierCents,
    ).toBe(16_031)
  })

  it('takes a number’s own digits', () => {
    expect(
      lineCostUsd({ kind: 'transfer', transferUsd: 0.29, isCountryCode: false }, 1e-7),
    ).toEqual({ supplierCents: 29, icannCents: 0 })
  })

  it('refuses anything that is not a non-negative amount — a wrong number is worse than none', () => {
    for (const bad of ['', '.', 'abc', '-1', '1e3', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        lineCostUsd({ kind: 'transfer', transferUsd: bad, isCountryCode: true }, 0),
      ).toThrow('Not a USD amount')
    }
    expect(() =>
      lineCostUsd({ kind: 'transfer', transferUsd: '1', isCountryCode: false }, 'x'),
    ).toThrow('Not a USD amount')
  })
})

describe('the float pre-flight and the recorded costs agree to the cent', () => {
  it('sums every line — register (.ai 2-year too), renew, transfer, certificate — into the total', () => {
    const lines: LineCost[] = [
      ...wholesaleCostUsd(
        [
          { tld: 'com', periodYears: 2 },
          { tld: 'ai', periodYears: 2 },
        ],
        new Map([
          ['com', COM],
          ['ai', AI],
        ]),
        '0.2000',
      ),
      lineCostUsd({ kind: 'renew', years: 3, renewUsd: '11.5100', isCountryCode: false }, '0.2000'),
      lineCostUsd({ kind: 'transfer', transferUsd: '10.6100', isCountryCode: false }, '0.2000'),
      ...sslCostUsd([{ productCode: '351' }], new Map([['351', '6.99']])),
    ]
    const rows = costRows(['a', 'b', 'c', 'd', 'e'], lines)
    expect(rows).toEqual([
      { order_item_id: 'a', supplier_cost_cents: 2282, icann_fee_cents: 40 },
      { order_item_id: 'b', supplier_cost_cents: 19_980, icann_fee_cents: 0 },
      { order_item_id: 'c', supplier_cost_cents: 3453, icann_fee_cents: 60 },
      { order_item_id: 'd', supplier_cost_cents: 1061, icann_fee_cents: 20 },
      { order_item_id: 'e', supplier_cost_cents: 699, icann_fee_cents: 0 },
    ])
    const recorded = rows.reduce(
      (sum, row) => sum + row.supplier_cost_cents + row.icann_fee_cents,
      0,
    )
    expect(totalCents(lines)).toBe(recorded)
    expect(recorded).toBe(27_595)
    for (const row of rows) {
      expect(Number.isSafeInteger(row.supplier_cost_cents)).toBe(true)
      expect(Number.isSafeInteger(row.icann_fee_cents)).toBe(true)
    }
  })

  it('gives the float check the same total the old float arithmetic did, for real prices', () => {
    // The rule before B15: Math.round((first + later + ICANN) × 100) per line.
    const before = (register: number, renew: number, first: number, years: number, icann: number) =>
      Math.round((register * first + renew * (years - first) + icann * years) * 100)
    const prices: [number, number, number, number][] = [
      [11.31, 11.51, 1, 0.2],
      [8.95, 12.99, 1, 0.2],
      [0.99, 33.33, 1, 0.18],
      [99.9, 99.9, 2, 0],
      [19.49, 38.99, 1, 0],
    ]
    for (const [register, renew, first, icann] of prices) {
      for (let years = first; years <= 10; years += 1) {
        const cost = lineCostUsd(
          {
            kind: 'register',
            tld: 'x',
            periodYears: years,
            cost: {
              registerUsd: register,
              renewUsd: renew,
              isCountryCode: icann === 0,
              firstTermYears: first,
            },
          },
          icann,
        )
        expect(cost.supplierCents + cost.icannCents).toBe(
          before(register, renew, first, years, icann),
        )
      }
    }
  })

  it('names each line by position, and never invents a row for a line it has no cost for', () => {
    expect(costRows(['a', 'b'], [{ supplierCents: 1, icannCents: 0 }])).toEqual([
      { order_item_id: 'a', supplier_cost_cents: 1, icann_fee_cents: 0 },
    ])
    expect(totalCents([])).toBe(0)
  })
})
