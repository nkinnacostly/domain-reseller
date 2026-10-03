import { describe, expect, it } from 'vitest'
import {
  addYears,
  MAX_YEARS_AHEAD,
  priceRise,
  type RenewableDomain,
  renewability,
  renewalCostUsd,
  renewalYearsRefusal,
} from '../lib/renewal'

const NOW = new Date('2026-09-24T12:00:00.000Z')
const DOMAIN: RenewableDomain = {
  source: 'registration',
  status: 'active',
  testMode: true,
  expiresAt: '2027-09-23T10:00:00.000Z',
}
const EVERY_YEAR = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const OPTIONS = { paymentTestMode: true, renewPeriods: EVERY_YEAR, inProgress: false, now: NOW }
const upTo = (max: number) => EVERY_YEAR.filter((years) => years <= max)

describe('renewability (FR-RN1, FR-RN5)', () => {
  it('offers every year up to ten years from today', () => {
    // Expires in a year: nine more years fit under the ten-year ceiling.
    expect(renewability(DOMAIN, OPTIONS)).toEqual({ ok: true, maxYears: 9, years: upTo(9) })
  })

  it('stops at the extension’s own longest period', () => {
    expect(renewability(DOMAIN, { ...OPTIONS, renewPeriods: upTo(5) })).toEqual({
      ok: true,
      maxYears: 5,
      years: upTo(5),
    })
  })

  it('offers only the blocks a registry renews in, under the ten-year limit (.ai)', () => {
    expect(renewability(DOMAIN, { ...OPTIONS, renewPeriods: [2, 4, 6, 8, 10] })).toEqual({
      ok: true,
      maxYears: 8,
      years: [2, 4, 6, 8],
    })
  })

  it('says why a block-sold domain too near the limit cannot be renewed yet', () => {
    const nearly = { ...DOMAIN, expiresAt: addYears(NOW, 9).toISOString() }
    const check = renewability(nearly, { ...OPTIONS, renewPeriods: [2, 4, 6, 8, 10] })
    expect(check).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /renews it only 2 years at a time.*8 years or less from expiry/,
      ),
    })
    // A year at a time still fits there.
    expect(renewability(nearly, OPTIONS)).toMatchObject({ ok: true, years: [1] })
  })

  it('renews a domain in its grace period at the normal price', () => {
    const expired = {
      ...DOMAIN,
      status: 'expired_grace' as const,
      expiresAt: '2026-09-01T00:00:00Z',
    }
    expect(renewability(expired, OPTIONS)).toEqual({ ok: true, maxYears: 10, years: EVERY_YEAR })
  })

  it('refuses once the domain is already ten years ahead', () => {
    const held = { ...DOMAIN, expiresAt: addYears(NOW, MAX_YEARS_AHEAD).toISOString() }
    const check = renewability(held, OPTIONS)
    expect(check).toEqual({ ok: false, reason: expect.stringMatching(/10 years ahead/) })
  })

  it('never renews a demo domain', () => {
    expect(renewability({ ...DOMAIN, source: 'demo' }, OPTIONS)).toEqual({
      ok: false,
      reason: 'Demo domains can’t be renewed.',
    })
  })

  it('sends a domain in redemption to email for a restore quote (FR-RN6)', () => {
    const check = renewability({ ...DOMAIN, status: 'redemption' }, OPTIONS)
    expect(check.ok).toBe(false)
    expect(!check.ok && check.reason).toMatch(/restore.*email hello@mydomainshub\.com/)
  })

  it('refuses a domain the registry is deleting', () => {
    const check = renewability({ ...DOMAIN, status: 'pending_delete' }, OPTIONS)
    expect(!check.ok && check.reason).toMatch(/deleting this domain/)
  })

  it.each([
    ['pending', DOMAIN.expiresAt],
    ['registration_failed', DOMAIN.expiresAt],
    ['active', null],
  ] as const)('refuses a %s domain, or one with no expiry', (status, expiresAt) => {
    expect(renewability({ ...DOMAIN, status, expiresAt }, OPTIONS)).toEqual({
      ok: false,
      reason: 'Only a registered domain can be renewed.',
    })
  })

  it('pauses when payments are not set up', () => {
    const check = renewability(DOMAIN, { ...OPTIONS, paymentTestMode: null })
    expect(!check.ok && check.reason).toMatch(/Payments aren’t set up/)
  })

  it('never renews a sandbox domain with a real payment, or a live one with a test payment', () => {
    const sandbox = renewability(DOMAIN, { ...OPTIONS, paymentTestMode: false })
    expect(!sandbox.ok && sandbox.reason).toMatch(/test system/)
    const live = renewability({ ...DOMAIN, testMode: false }, OPTIONS)
    expect(!live.ok && live.reason).toMatch(/needs live payments/)
  })

  it('refuses a second renewal while one is being made', () => {
    const check = renewability(DOMAIN, { ...OPTIONS, inProgress: true })
    expect(!check.ok && check.reason).toMatch(/already paid for/)
  })

  it('withholds renewal without a price for the extension (N5b)', () => {
    const check = renewability(DOMAIN, { ...OPTIONS, renewPeriods: null })
    expect(!check.ok && check.reason).toMatch(/prices for this extension are unavailable/)
    const none = renewability(DOMAIN, { ...OPTIONS, renewPeriods: [] })
    expect(!none.ok && none.reason).toMatch(/prices for this extension are unavailable/)
  })
})

describe('renewalYearsRefusal (N9b)', () => {
  const blocks = { maxYears: 8, years: [2, 4, 6, 8] }

  it('accepts a period on offer', () => {
    expect(renewalYearsRefusal(blocks, 4)).toBeNull()
  })

  it('refuses a year the registry does not renew in, naming the ones it does', () => {
    expect(renewalYearsRefusal(blocks, 3)).toBe(
      'This domain can be renewed for 2, 4, 6 or 8 years at a time.',
    )
    expect(renewalYearsRefusal(blocks, 1, 'getpaid.ai')).toBe(
      'getpaid.ai can be renewed for 2, 4, 6 or 8 years at a time.',
    )
  })

  it('keeps the old wording for a period past the ten-year limit', () => {
    expect(renewalYearsRefusal(blocks, 10)).toBe(
      'This domain can be renewed for at most 8 years now.',
    )
    expect(renewalYearsRefusal({ maxYears: 1, years: [1] }, 2)).toBe(
      'This domain can be renewed for at most 1 year now.',
    )
  })
})

describe('addYears', () => {
  it('adds calendar years in UTC', () => {
    expect(addYears('2027-09-23T10:00:00.000Z', 2).toISOString()).toBe('2029-09-23T10:00:00.000Z')
    expect(addYears(new Date('2028-02-29T00:00:00.000Z'), 1).toISOString()).toBe(
      '2029-03-01T00:00:00.000Z',
    )
  })
})

describe('renewalCostUsd (FR-C8)', () => {
  it('adds the ICANN fee each year on generic extensions, split out', () => {
    // $11.51 a year for two years, and $0.20 a year for ICANN: $23.42.
    expect(renewalCostUsd({ renewUsd: 11.51, isCountryCode: false }, 2, 0.2)).toEqual({
      supplierCents: 2302,
      icannCents: 40,
    })
  })

  it('leaves the ICANN fee off country-code extensions', () => {
    expect(renewalCostUsd({ renewUsd: 30, isCountryCode: true }, 3, 0.2)).toEqual({
      supplierCents: 9000,
      icannCents: 0,
    })
  })

  it('reads the catalogue’s decimal text exactly (.ai renews two years at a time)', () => {
    expect(renewalCostUsd({ renewUsd: '99.9000', isCountryCode: true }, 2, '0.2000')).toEqual({
      supplierCents: 19_980,
      icannCents: 0,
    })
  })
})

describe('priceRise (FR-RN7)', () => {
  it('reports a renewal price higher than the one last paid or quoted', () => {
    expect(priceRise(1_870_000, 1_950_000)).toEqual({ from: 1_870_000, to: 1_950_000 })
  })

  it('stays quiet when the price held, fell, or was never quoted', () => {
    expect(priceRise(1_870_000, 1_870_000)).toBeNull()
    expect(priceRise(1_950_000, 1_870_000)).toBeNull()
    expect(priceRise(null, 1_870_000)).toBeNull()
  })
})
