import { describe, expect, it } from 'vitest'
import { formatNaira, KOBO_PER_NAIRA } from './index'
import {
  bandFor,
  CATALOGUE,
  type CatalogueEntry,
  DEFAULT_BANDS,
  findTld,
  icannFeeApplies,
  isCountryCodeTld,
  priceCatalogue,
  quote,
} from './policy'

const FX = { midRate: 1550, bufferPct: 4 }
const naira = (kobo: number) => kobo / KOBO_PER_NAIRA

describe('isCountryCodeTld', () => {
  it.each(['ng', 'io', 'co', 'me', 'uk', 'com.ng', 'org.ng', 'co.uk'])(
    'treats .%s as a country-code TLD',
    (name) => expect(isCountryCodeTld(name)).toBe(true),
  )

  it.each(['com', 'net', 'org', 'app', 'dev', 'xyz', 'africa'])(
    'treats .%s as a generic TLD',
    (name) => expect(isCountryCodeTld(name)).toBe(false),
  )

  it('charges the ICANN fee on gTLDs only', () => {
    expect(icannFeeApplies('com')).toBe(true)
    expect(icannFeeApplies('ng')).toBe(false)
    expect(icannFeeApplies('com.ng')).toBe(false)
  })
})

describe('margin bands', () => {
  it('earns more on renewal than on registration by default', () => {
    expect(DEFAULT_BANDS.renewal.marginPct).toBeGreaterThan(DEFAULT_BANDS.registration.marginPct)
  })

  it('prices transfers closest to cost, to win portfolios', () => {
    expect(DEFAULT_BANDS.transfer.marginPct).toBeLessThan(DEFAULT_BANDS.registration.marginPct)
  })

  it('thins the margin on .com, where our wholesale is already uncompetitive', () => {
    expect(bandFor('com', 'registration').marginPct).toBeLessThan(
      DEFAULT_BANDS.registration.marginPct,
    )
  })

  it('falls back to the default band for a TLD with no override', () => {
    expect(bandFor('xyz', 'registration')).toEqual(DEFAULT_BANDS.registration)
  })

  it('merges a partial override over the default rather than replacing it', () => {
    const band = bandFor('ng', 'registration')
    expect(band.marginPct).toBe(20)
    // The override only sets marginPct; floor and cap come from the default.
    expect(band.capNgn).toBe(DEFAULT_BANDS.registration.capNgn)
    expect(band.floorNgn).toBe(DEFAULT_BANDS.registration.floorNgn)
  })

  it('gives the .ng family identical registration and renewal margins', () => {
    for (const tld of ['ng', 'com.ng', 'org.ng', 'net.ng']) {
      expect(bandFor(tld, 'registration').marginPct, tld).toBe(bandFor(tld, 'renewal').marginPct)
    }
  })
})

describe('quote', () => {
  const ng = findTld('ng') as CatalogueEntry
  const com = findTld('com') as CatalogueEntry

  it('never sells below landed cost', () => {
    for (const entry of CATALOGUE) {
      for (const kind of ['registration', 'renewal', 'transfer'] as const) {
        const q = quote(entry, kind, FX)
        if (!q) continue
        expect(q.priceKobo, `${entry.name} ${kind}`).toBeGreaterThan(q.costKobo)
      }
    }
  })

  it('always clears the margin floor, even on a $0.99 TLD', () => {
    for (const entry of CATALOGUE) {
      const q = quote(entry, 'registration', FX)
      if (!q) continue
      const floor = bandFor(entry.name, 'registration').floorNgn
      // Psychological rounding only ever rounds up, so the floor holds.
      expect(naira(q.marginKobo), `${entry.name}`).toBeGreaterThanOrEqual(floor)
    }
  })

  it('respects the margin cap on expensive TLDs', () => {
    const io = findTld('io') as CatalogueEntry
    const q = quote(io, 'renewal', FX)
    expect(q).not.toBeNull()
    // Rounding can push a little past the cap; allow one rounding step.
    expect(naira(q?.marginKobo ?? 0)).toBeLessThanOrEqual(bandFor('io', 'renewal').capNgn + 900)
  })

  it('adds the ICANN fee to a gTLD but not a ccTLD', () => {
    const comQuote = quote(com, 'registration', FX)
    const ngQuote = quote(ng, 'registration', FX)

    const rate = 1550 * 1.04
    expect(naira(comQuote?.costKobo ?? 0)).toBeCloseTo((11.31 + 0.2) * rate, 0)
    expect(naira(ngQuote?.costKobo ?? 0)).toBeCloseTo(11.99 * rate, 0)
  })

  it('charges VAT at 7.5% on top of the price', () => {
    const q = quote(ng, 'registration', FX)
    expect(q?.vatKobo).toBe(Math.round((q?.priceKobo ?? 0) * 0.075))
    expect(q?.totalKobo).toBe((q?.priceKobo ?? 0) + (q?.vatKobo ?? 0))
  })

  it('returns null where the supplier does not price a transfer', () => {
    // .ng has no transfer price in the catalogue.
    expect(quote(ng, 'transfer', FX)).toBeNull()
  })

  it('rejects a non-positive FX rate rather than giving domains away', () => {
    expect(() => quote(ng, 'registration', { midRate: 0, bufferPct: 4 })).toThrow(RangeError)
  })
})

describe('priceCatalogue', () => {
  const priced = priceCatalogue(FX)

  it('prices the whole sellable catalogue', () => {
    expect(priced.length).toBeGreaterThan(650)
  })

  it('includes all four Nigerian extensions', () => {
    const ngFamily = priced.filter((p) => p.tld === 'ng' || p.tld.endsWith('.ng'))
    expect(ngFamily.map((p) => p.tld).sort()).toEqual(['com.ng', 'net.ng', 'ng', 'org.ng'])
  })

  it('flags .com as renewing higher than its first year', () => {
    expect(priced.find((p) => p.tld === 'com')?.renewalIsHigher).toBe(true)
  })

  /**
   * The .ng family is our flagship range and is sold at one price every year.
   * A flagship that renews higher than year one would undercut the promise the
   * whole storefront is built on.
   */
  it('prices the whole .ng family flat, year after year', () => {
    for (const tld of ['ng', 'com.ng', 'org.ng', 'net.ng']) {
      const p = priced.find((x) => x.tld === tld)
      expect(p, tld).toBeDefined()
      expect(p?.renewalIsHigher, tld).toBe(false)
      expect(p?.registration.priceKobo, tld).toBe(p?.renewal.priceKobo)
    }
  })

  it('keeps every price a whole number of naira', () => {
    for (const p of priced.slice(0, 50)) {
      expect(formatNaira(p.registration.priceKobo)).not.toMatch(/\./)
    }
  })

  it('is deterministic for a given FX rate', () => {
    expect(priceCatalogue(FX)).toEqual(priced)
  })
})
