import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { POPULAR_TLDS, sortForDisplay, toPublicRow } from '../lib/public-row'

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
  record('co', 24.49),
  record('com', 11.31, 11.51, 10.61),
  record('africa', 25.9),
  record('org', 10.99, 10.99, 10.99),
  record('zzz-tail', 4.2),
  record('aaa-tail', 7.1),
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
      'registerYears',
      'renew',
      'renewYears',
      'renewalIsHigher',
      'requiresExtraFields',
      'tld',
      'transfer',
    ])
  })

  it('keeps a one-year extension’s prices per year, as before', () => {
    const [com] = priceCatalogue([record('com', 11.31, 11.51)], INPUTS)
    if (!com) throw new Error('fixture')
    expect(toPublicRow(com)).toMatchObject({
      registerYears: 1,
      renewYears: 1,
      registerRank: com.registration.priceKobo,
    })
  })

  it('shows a block-sold extension’s shortest term, and ranks it by what it costs (.ai)', () => {
    const [ai] = priceCatalogue(
      [
        {
          ...record('ai', 99.9),
          minPeriod: 2,
          registerPeriods: [2, 4, 6, 8, 10],
          renewPeriods: [2, 4, 6, 8, 10],
        },
      ],
      INPUTS,
    )
    if (!ai) throw new Error('fixture')
    const row = toPublicRow(ai)
    expect(row).toMatchObject({ registerYears: 2, renewYears: 2, maxPeriod: 10 })
    expect(row.registerRank).toBe(2 * ai.registration.priceKobo)
    expect(row.register).toMatch(/^₦[\d,]+$/)
  })

  it('formats money as naira strings, so the client does no maths', () => {
    expect(rows.find((r) => r.tld === 'co')?.register).toMatch(/^₦[\d,]+$/)
  })

  it('returns null rather than a price where transfer is unavailable', () => {
    expect(rows.find((r) => r.tld === 'co')?.transfer).toBeNull()
    expect(rows.find((r) => r.tld === 'com')?.transfer).not.toBeNull()
  })
})

describe('sortForDisplay', () => {
  // Featured order comes from the database; here, a ranking that disagrees
  // with POPULAR_TLDS so the test proves the featured order wins.
  const featured = ['africa', 'co']
  const sorted = sortForDisplay(rows, featured)
  const sellablePopular = POPULAR_TLDS.filter(
    (t) => !featured.includes(t) && rows.some((r) => r.tld === t),
  )

  it('puts featured extensions first, in the order given', () => {
    expect(sorted.slice(0, 2).map((r) => r.tld)).toEqual(featured)
  })

  it('follows them with extensions people recognise', () => {
    expect(sorted.slice(2, 2 + sellablePopular.length).map((r) => r.tld)).toEqual([
      ...sellablePopular,
    ])
  })

  it('leaves the long tail alphabetical, so a reader can find one', () => {
    const tail = sorted.slice(2 + sellablePopular.length).map((r) => r.tld)
    expect(tail).toEqual(['aaa-tail', 'zzz-tail'])
  })

  it('falls back to the popular order when nothing is featured', () => {
    expect(sortForDisplay(rows)[0]?.tld).toBe('com')
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
