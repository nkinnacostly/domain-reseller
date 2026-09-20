import type { FxSettings } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { featuredTlds } from '../lib/featured-tlds'

// A fixed rate so expectations do not move with the database.
const FX: FxSettings = { midRate: 1550, bufferPct: 4 }

describe('featuredTlds', () => {
  const featured = featuredTlds(FX)

  it('merchandises the Nigerian extensions first', () => {
    expect(featured.map((f) => f.tld)).toEqual(['ng', 'com.ng', 'com'])
  })

  /** PRD N8 — a price is never shown without its renewal price. */
  it('carries a renewal price for every extension', () => {
    for (const f of featured) expect(f.renewal).toMatch(/^₦[\d,]+$/)
  })

  it('flags .com, where renewal costs more than the first year', () => {
    expect(featured.find((f) => f.tld === 'com')?.renewalIsHigher).toBe(true)
  })

  it('does not flag the flat-priced .ng family', () => {
    const ng = featured.find((f) => f.tld === 'ng')
    expect(ng?.renewalIsHigher).toBe(false)
    expect(ng?.firstYear).toBe(ng?.renewal)
  })

  it('formats prices as whole naira', () => {
    for (const f of featured) expect(f.firstYear).toMatch(/^₦[\d,]+$/)
  })

  it('moves every price when the rate moves', () => {
    const cheaper = featuredTlds({ midRate: 1000, bufferPct: 4 })
    for (const [i, f] of featured.entries()) {
      expect(cheaper[i]?.firstYear).not.toBe(f.firstYear)
    }
  })
})
