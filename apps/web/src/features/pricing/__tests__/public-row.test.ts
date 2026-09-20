import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { NIGERIAN_TLDS, POPULAR_TLDS, sortForDisplay, toPublicRow } from '../lib/public-row'

// Fixed inputs so expectations do not move with the live rate.
const INPUTS: PricingInputs = {
  fxRate: 1333.76,
  fxBufferPct: 0,
  marginNgn: 3000,
  icannFeeUsd: 0.2,
}

const record = (
  name: string,
  register: number,
  renew = register,
  transfer: number | null = null,
): TldRecord => ({
  name,
  registerUsd: register,
  renewUsd: renew,
  transferUsd: transfer,
  restoreUsd: null,
  isCountryCode: name.split('.').pop()?.length === 2,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})

const records: TldRecord[] = [
  record('ng', 11.99),
  record('com.ng', 11.99, 11.99, 11.99),
  record('net.ng', 11.99, 11.99, 11.99),
  record('org.ng', 11.99, 11.99, 11.99),
  record('com', 11.31, 11.51, 10.61),
  record('africa', 25.9),
  record('zzz-tail', 4.2),
]

const rows = priceCatalogue(records, INPUTS).map(toPublicRow)

describe('toPublicRow', () => {
  /** Wholesale cost and margin must never reach the browser. */
  it('never exposes cost or margin', () => {
    const serialised = JSON.stringify(rows)
    expect(serialised).not.toMatch(/cost/i)
    expect(serialised).not.toMatch(/margin/i)

    for (const key of Object.keys(rows[0] ?? {})) {
      expect(key).not.toMatch(/cost|margin|wholesale|supplier/i)
    }
  })

  it('exposes only the agreed fields', () => {
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'isCountryCode',
      'maxPeriod',
      'register',
      'registerRank',
      'renew',
      'renewalIsHigher',
      'requiresExtraFields',
      'tld',
      'transfer',
    ])
  })

  it('formats money as naira strings, so the client does no maths', () => {
    expect(rows.find((r) => r.tld === 'ng')?.register).toMatch(/^₦[\d,]+$/)
  })

  it('returns null rather than a price where transfer is unavailable', () => {
    expect(rows.find((r) => r.tld === 'ng')?.transfer).toBeNull()
    expect(rows.find((r) => r.tld === 'com')?.transfer).not.toBeNull()
  })
})

describe('sortForDisplay', () => {
  const sorted = sortForDisplay(rows)

  it('puts the Nigerian extensions first, in a fixed order', () => {
    expect(sorted.slice(0, 4).map((r) => r.tld)).toEqual([...NIGERIAN_TLDS])
  })

  it('follows them with extensions people recognise', () => {
    const sellablePopular = POPULAR_TLDS.filter((t) => rows.some((r) => r.tld === t))
    expect(sorted.slice(4, 4 + sellablePopular.length).map((r) => r.tld)).toEqual([
      ...sellablePopular,
    ])
  })

  it('leaves the long tail alphabetical, so a reader can find one', () => {
    const sellablePopular = POPULAR_TLDS.filter((t) => rows.some((r) => r.tld === t))
    const tail = sorted.slice(4 + sellablePopular.length).map((r) => r.tld)
    expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)))
  })

  it('does not mutate the input', () => {
    const before = rows.map((r) => r.tld)
    sortForDisplay(rows)
    expect(rows.map((r) => r.tld)).toEqual(before)
  })
})

describe('flat margin', () => {
  /** Every extension earns the same ₦3,000, whatever it costs. */
  it('earns the same profit on a cheap and an expensive extension', () => {
    const priced = priceCatalogue(records, INPUTS)
    const margins = priced.map((p) => Math.floor(p.registration.marginKobo / 10_000))
    expect(new Set(margins).size).toBe(1)
  })
})
