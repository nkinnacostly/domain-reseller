import { type FxSettings, priceCatalogue } from '@dr/shared'

// A fixed rate for the test, so expectations do not move with the database.
const FX: FxSettings = { midRate: 1550, bufferPct: 4 }

import { describe, expect, it } from 'vitest'
import { NIGERIAN_TLDS, POPULAR_TLDS, sortForDisplay, toPublicRow } from '../lib/public-row'

const priced = priceCatalogue(FX)
const rows = priced.map(toPublicRow)

describe('toPublicRow', () => {
  /**
   * The important one. Wholesale cost and margin are commercially sensitive;
   * shipping them to the browser would hand our buying position to anyone who
   * opens devtools.
   */
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
    const ng = rows.find((r) => r.tld === 'ng')
    expect(ng?.register).toMatch(/^₦[\d,]+$/)
    expect(ng?.renew).toMatch(/^₦[\d,]+$/)
  })

  it('returns null rather than a price where transfer is unavailable', () => {
    expect(rows.find((r) => r.tld === 'ng')?.transfer).toBeNull()
  })
})

describe('sortForDisplay', () => {
  const sorted = sortForDisplay(rows)

  it('puts the Nigerian extensions first, in a fixed order', () => {
    expect(sorted.slice(0, 4).map((r) => r.tld)).toEqual([...NIGERIAN_TLDS])
  })

  // Not every popular TLD is sellable — .ai has no registration price at our
  // tier, only transfer — so compare against the ones actually in the catalogue.
  const sellablePopular = POPULAR_TLDS.filter((t) => rows.some((r) => r.tld === t))

  it('follows the Nigerian range with the extensions people recognise', () => {
    const afterNg = sorted.slice(4, 4 + sellablePopular.length).map((r) => r.tld)
    expect(afterNg).toEqual([...sellablePopular])
  })

  /**
   * Regression: sorting the long tail by price put restricted Turkish
   * second-levels at the top of the table — cheap, and unregisterable here.
   */
  it('does not lead the long tail with restricted .tr extensions', () => {
    const firstTail = sorted.slice(4 + sellablePopular.length, 4 + sellablePopular.length + 10)
    expect(firstTail.filter((r) => r.tld.endsWith('.tr')).length).toBeLessThan(5)
  })

  it('orders the long tail alphabetically, so a reader can find one', () => {
    const tail = sorted.slice(4 + sellablePopular.length).map((r) => r.tld)
    expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)))
  })

  it('does not mutate the input', () => {
    const before = rows.map((r) => r.tld)
    sortForDisplay(rows)
    expect(rows.map((r) => r.tld)).toEqual(before)
  })
})
