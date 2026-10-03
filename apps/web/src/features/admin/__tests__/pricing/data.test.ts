import { describe, expect, it } from 'vitest'
import {
  exactCents,
  parsePricingStatus,
  parseRateRows,
  parseSampleTld,
} from '@/features/admin/lib/pricing-data'
import { rateRow, rawRate, staleRow, status } from './fixtures'

/**
 * What the Pricing & FX pages read, parsed (docs/ADMIN-SPEC.md §3.2h): an
 * answer of the wrong shape is refused rather than shown, and the example's
 * dollars become whole cents only when that is exactly the amount (D24).
 */

/** `admin_pricing_status()` as jsonb arrives: numerics as numbers. */
function answer() {
  const value = status()
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

describe('admin_pricing_status', () => {
  it('reads settings, counts, the active rate and the held ones', () => {
    const parsed = parsePricingStatus(answer())
    expect(parsed).toEqual({ status: status() })
  })

  it('reads numerics sent as text, and no settings or active rate as none', () => {
    const json = answer()
    const fx = json.fx as { active: unknown; pending: Record<string, unknown>[] }
    fx.active = null
    ;(fx.pending[0] as Record<string, unknown>).costingRate = '1700.0000'
    ;(fx.pending[0] as Record<string, unknown>).movePct = null
    json.settings = null
    const parsed = parsePricingStatus(json)
    expect('status' in parsed && parsed.status.fx.active).toBeNull()
    expect('status' in parsed && parsed.status.fx.pending[0]?.costingRate).toBe(1700)
    expect('status' in parsed && parsed.status.fx.pending[0]?.movePct).toBeNull()
    expect('status' in parsed && parsed.status.settings).toBeNull()
  })

  it('refuses an answer of another shape, and says how much was wrong', () => {
    expect(parsePricingStatus(null)).toEqual({ issues: 1 })
    const json = answer()
    ;(json.settings as Record<string, unknown>).icannFeeCents = 0.2
    ;(json.tlds as Record<string, unknown>).total = 'many'
    expect(parsePricingStatus(json)).toEqual({ issues: 2 })
    const bad = answer()
    ;(bad.settings as Record<string, unknown>).marginNgn = 'Infinity'
    expect('issues' in parsePricingStatus(bad)).toBe(true)
  })
})

describe('fx_rates rows', () => {
  it('reads PostgREST rows into the page’s names, numerics as numbers', () => {
    const raw = { ...rawRate(staleRow()), costing_rate: '1700.0000', buffer_pct: '4.0000' }
    expect(parseRateRows([raw, rawRate(rateRow())])).toEqual([staleRow(), rateRow()])
  })

  it('refuses rows that are not what the table holds', () => {
    expect(parseRateRows(null)).toBeNull()
    expect(parseRateRows([{ ...rawRate(rateRow()), costing_rate: null }])).toBeNull()
    expect(parseRateRows([{ ...rawRate(rateRow()), quoted_at: '' }])).toBeNull()
  })
})

describe('the example extension', () => {
  const row = {
    name: 'com',
    register_usd: 11.31,
    renew_usd: '11.5100',
    is_country_code: false,
    min_period: 1,
    max_period: 10,
    register_periods: [1, 2, 3],
    renew_periods: [1, 2],
    is_sellable: true,
    is_paused: false,
  }

  it('turns dollars into whole cents only when that is exactly the amount', () => {
    expect(exactCents(11.31)).toBe(1131)
    expect(exactCents('11.3100')).toBe(1131)
    expect(exactCents(0)).toBe(0)
    expect(exactCents(79.995)).toBeNull()
    expect(exactCents('11.315')).toBeNull()
    expect(exactCents(-1)).toBeNull()
    expect(exactCents('abc')).toBeNull()
    expect(exactCents(null)).toBeNull()
    expect(exactCents(Number.NaN)).toBeNull()
  })

  it('reads the row, in cents, and says whether the storefront sells it', () => {
    expect(parseSampleTld(row)).toEqual({
      name: 'com',
      registerCents: 1131,
      renewCents: 1151,
      isCountryCode: false,
      minPeriod: 1,
      maxPeriod: 10,
      registerPeriods: [1, 2, 3],
      renewPeriods: [1, 2],
      onSale: true,
    })
    expect(parseSampleTld({ ...row, is_paused: true })?.onSale).toBe(false)
    expect(parseSampleTld({ ...row, is_sellable: false })?.onSale).toBe(false)
  })

  it('reads a row synced before the period columns as listing none', () => {
    const { register_periods: _r, renew_periods: _n, ...older } = row
    expect(parseSampleTld(older)).toMatchObject({ registerPeriods: null, renewPeriods: null })
    expect(parseSampleTld({ ...row, register_periods: null })?.registerPeriods).toBeNull()
  })

  it('shows no example for a missing, malformed or sub-cent row', () => {
    expect(parseSampleTld(undefined)).toBeNull()
    expect(parseSampleTld({ ...row, name: '' })).toBeNull()
    expect(parseSampleTld({ ...row, register_usd: 11.3125 })).toBeNull()
    expect(parseSampleTld({ ...row, renew_usd: 'n/a' })).toBeNull()
  })
})
