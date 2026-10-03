import * as shared from '@dr/shared/pricing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  changesPrices,
  chargedRate,
  fieldBoundsWords,
  hasDecimals,
  movePct,
  PRICING_FIELDS,
  parseFieldValue,
  priceEffect,
  pricingChanges,
  pricingInputs,
  RATE_MAX_AGE_HOURS,
  rateOffers,
  sampleRecord,
  settingsAfter,
  termsAt,
} from '@/features/admin/lib/pricing-rules'
import { aiSample, comSample, hoursAgo, NOW, settings } from './fixtures'

/**
 * The Pricing & FX rules (docs/ADMIN-SPEC.md §3.1.2, §5.2 B12). The refusal
 * first: a held rate quoted 48 hours ago or more, or no later than the
 * active one, offers Reject only. Then the impact line: every price it
 * names comes out of the storefront's own `priceCatalogue`, never maths of
 * its own.
 */

vi.mock('@dr/shared/pricing', async (original) => {
  const actual = await original<typeof import('@dr/shared/pricing')>()
  return { ...actual, priceCatalogue: vi.fn(actual.priceCatalogue) }
})

beforeEach(() => {
  vi.clearAllMocks()
})

const ACTIVE = { quotedAt: hoursAgo(11) }

describe('which held rates may be activated', () => {
  it('offers Reject only for a rate quoted 48 hours ago or more', () => {
    for (const hours of [RATE_MAX_AGE_HOURS, 49, 13 * 24]) {
      expect(rateOffers({ quotedAt: hoursAgo(hours) }, null, NOW), `${hours} h`).toEqual({
        activate: false,
        reject: true,
        blockedBy: 'too_old',
      })
    }
  })

  it('offers Reject only for a rate quoted before the active one, or at the same moment', () => {
    for (const hours of [11, 12, 30]) {
      expect(rateOffers({ quotedAt: hoursAgo(hours) }, ACTIVE, NOW), `${hours} h`).toEqual({
        activate: false,
        reject: true,
        blockedBy: 'older_than_active',
      })
    }
  })

  it("takes SQL's word when it says too old or older than the active rate", () => {
    const fresh = hoursAgo(1)
    expect(rateOffers({ quotedAt: fresh, tooOld: true }, ACTIVE, NOW).blockedBy).toBe('too_old')
    expect(rateOffers({ quotedAt: fresh, olderThanActive: true }, ACTIVE, NOW).blockedBy).toBe(
      'older_than_active',
    )
  })

  it('names the age first when a rate is both too old and older than the active one', () => {
    expect(rateOffers({ quotedAt: hoursAgo(72) }, ACTIVE, NOW).blockedBy).toBe('too_old')
  })

  it('refuses a quote time it cannot read', () => {
    expect(rateOffers({ quotedAt: 'not a time' }, null, NOW).activate).toBe(false)
    expect(rateOffers({ quotedAt: hoursAgo(1) }, { quotedAt: 'nope' }, NOW).activate).toBe(false)
  })

  it('offers Activate for a rate under 48 hours old and newer than the active one', () => {
    expect(rateOffers({ quotedAt: hoursAgo(47.9) }, null, NOW)).toEqual({
      activate: true,
      reject: true,
      blockedBy: null,
    })
    expect(rateOffers({ quotedAt: hoursAgo(4) }, ACTIVE, NOW).activate).toBe(true)
  })
})

describe('moves and rates', () => {
  it('measures a move between costing rates, and has none without both', () => {
    expect(movePct(1523.4, 1328.1)).toBeCloseTo(14.705, 3)
    expect(movePct(1330, 1400)).toBeCloseTo(-5, 3)
    expect(movePct(1330, null)).toBeNull()
    expect(movePct(1330, 0)).toBeNull()
    expect(movePct(0, 1330)).toBeNull()
  })

  it("charges at the costing rate plus that rate's own buffer, through the shared function", () => {
    expect(chargedRate({ costingRate: 1700, bufferPct: 4 })).toBe(shared.effectiveFxRate(1700, 4))
    expect(chargedRate({ costingRate: 1700, bufferPct: 4 })).toBeCloseTo(1768, 9)
    expect(chargedRate({ costingRate: 1330.5689, bufferPct: 0 })).toBe(1330.5689)
  })

  it('assembles inputs as the storefront does: the rate and its buffer, the margin, the fee in dollars', () => {
    expect(
      pricingInputs({ costingRate: 1330.5689, bufferPct: 0 }, settings({ icannFeeCents: 18 })),
    ).toEqual({ fxRate: 1330.5689, fxBufferPct: 0, marginNgn: 4250, icannFeeUsd: 0.18 })
    expect(pricingInputs(null, settings())).toBeNull()
    expect(pricingInputs({ costingRate: 1, bufferPct: 0 }, null)).toBeNull()
  })
})

describe('the impact line', () => {
  const active = pricingInputs({ costingRate: 1330.5689, bufferPct: 0 }, settings())
  const fresh = pricingInputs({ costingRate: 1523.4, bufferPct: 0 }, settings())
  const stale = pricingInputs({ costingRate: 1700, bufferPct: 4 }, settings())

  it("prices the example with the shared priceCatalogue, exactly as the site's catalogue does", () => {
    const terms = termsAt(comSample(), active)
    expect(shared.priceCatalogue).toHaveBeenCalledWith([sampleRecord(comSample())], active)
    const [direct] = shared.priceCatalogue(
      [sampleRecord(comSample())],
      active as shared.PricingInputs,
    )
    expect(terms).toEqual({ first: direct?.firstTerm, renewal: direct?.renewalTerm })
  })

  it('gives .com its first year and renewal, hand-checked', () => {
    // (11.31 + 0.18) × 1,330.5689 + ₦4,250, up to the next ₦100; renewal from 11.51.
    expect(termsAt(comSample(), active)).toEqual({
      first: { years: 1, priceKobo: 1_960_000 },
      renewal: { years: 1, priceKobo: 1_990_000 },
    })
    // A 4% buffer on ₦1,700 charges ₦1,768.
    expect(termsAt(comSample(), stale)).toEqual({
      first: { years: 1, priceKobo: 2_460_000 },
      renewal: { years: 1, priceKobo: 2_500_000 },
    })
  })

  it('gives a block-sold country code its first term and renewal term, without the ICANN fee', () => {
    expect(termsAt(aiSample(), active)).toEqual({
      first: { years: 2, priceKobo: 27_440_000 },
      renewal: { years: 2, priceKobo: 27_440_000 },
    })
  })

  it('builds the record from whole cents, the same dollars the storefront reads', () => {
    expect(sampleRecord(comSample())).toMatchObject({
      name: 'com',
      registerUsd: 11.31,
      renewUsd: 11.51,
      isCountryCode: false,
    })
    expect(sampleRecord(comSample()).registerUsd).toBe(Number('11.3100'))
  })

  it('shows before and after for a new rate', () => {
    expect(priceEffect(comSample(), active, fresh)).toEqual({
      tld: 'com',
      before: {
        first: { years: 1, priceKobo: 1_960_000 },
        renewal: { years: 1, priceKobo: 1_990_000 },
      },
      after: {
        first: { years: 1, priceKobo: 2_180_000 },
        renewal: { years: 1, priceKobo: 2_210_000 },
      },
    })
  })

  it('has an after but no before when there is no active rate, and nothing without an example', () => {
    expect(priceEffect(comSample(), null, fresh)?.before).toBeNull()
    expect(priceEffect(comSample(), null, fresh)?.after?.first.priceKobo).toBe(2_180_000)
    expect(priceEffect(null, active, fresh)).toBeNull()
    expect(priceEffect(comSample(), null, null)).toBeNull()
  })

  it('is no price, not a guess, for inputs the shared functions refuse or a period not sold', () => {
    expect(
      termsAt(comSample(), { fxRate: 0, fxBufferPct: 0, marginNgn: 1, icannFeeUsd: 0 }),
    ).toBeNull()
    expect(termsAt(comSample({ registerPeriods: [] }), active)).toBeNull()
    expect(termsAt(comSample(), null)).toBeNull()
  })
})

describe('the settings form', () => {
  const current = settings()

  it('refuses each value outside what SQL allows, in words', () => {
    const typed = {
      margin_ngn: '999',
      fx_buffer_pct: '1.255',
      icann_fee_cents: '18.5',
      fx_move_threshold_pct: '0',
    }
    const { changes, errors } = pricingChanges(current, typed)
    expect(changes).toEqual({})
    expect(errors).toEqual({
      margin_ngn: 'Enter ₦1,000 to ₦50,000, in whole naira.',
      fx_buffer_pct: 'Enter 0% to 20%, with at most 2 decimal places.',
      icann_fee_cents: 'Enter 0 to 200 US cents, a whole number.',
      fx_move_threshold_pct: 'Enter 1% to 50%, with at most 2 decimal places.',
    })
    expect(pricingChanges(current, { margin_ngn: '' }).errors.margin_ngn).toBeDefined()
    expect(pricingChanges(current, { margin_ngn: '50001' }).errors.margin_ngn).toBeDefined()
    expect(pricingChanges(current, { fx_buffer_pct: '-1' }).errors.fx_buffer_pct).toBeDefined()
    expect(pricingChanges(current, { fx_buffer_pct: '1e1' }).errors.fx_buffer_pct).toBeDefined()
  })

  it('keeps only what moved, and reads a margin typed with a thousands comma', () => {
    const { changes, errors } = pricingChanges(current, {
      margin_ngn: '5,000',
      fx_buffer_pct: '1.50',
      icann_fee_cents: '18',
      fx_move_threshold_pct: '7.25',
    })
    expect(errors).toEqual({})
    expect(changes).toEqual({ margin_ngn: 5000, fx_move_threshold_pct: 7.25 })
  })

  it('accepts each bound itself', () => {
    for (const field of PRICING_FIELDS) {
      expect(parseFieldValue(field, String(field.min))).toEqual({ value: field.min })
      expect(parseFieldValue(field, String(field.max))).toEqual({ value: field.max })
    }
  })

  it('applies a change to the settings it prices the example at', () => {
    expect(settingsAfter(current, { margin_ngn: 5000, icann_fee_cents: 0 })).toEqual({
      ...current,
      marginNgn: 5000,
      icannFeeCents: 0,
    })
    expect(settingsAfter(current, { fx_buffer_pct: 2, fx_move_threshold_pct: 10 })).toMatchObject({
      fxBufferPct: 2,
      fxMoveThresholdPct: 10,
    })
    expect(settingsAfter(current, {})).toEqual(current)
  })

  it('says only margin and the ICANN fee reprice the site', () => {
    expect(changesPrices({ margin_ngn: 5000 })).toBe(true)
    expect(changesPrices({ icann_fee_cents: 0 })).toBe(true)
    expect(changesPrices({ fx_buffer_pct: 2, fx_move_threshold_pct: 10 })).toBe(false)
  })

  it('counts decimal places on the shortest text of a number', () => {
    expect(hasDecimals(4, 0)).toBe(true)
    expect(hasDecimals(4.5, 0)).toBe(false)
    expect(hasDecimals(4.25, 2)).toBe(true)
    expect(hasDecimals(4.255, 2)).toBe(false)
    expect(hasDecimals(Number.NaN, 2)).toBe(false)
    expect(hasDecimals(1e-7, 2)).toBe(false)
  })

  it('words each bound from the field itself', () => {
    expect(PRICING_FIELDS.map(fieldBoundsWords)).toEqual([
      'Enter ₦1,000 to ₦50,000, in whole naira.',
      'Enter 0% to 20%, with at most 2 decimal places.',
      'Enter 0 to 200 US cents, a whole number.',
      'Enter 1% to 50%, with at most 2 decimal places.',
    ])
  })
})
