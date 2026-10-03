import { describe, expect, it } from 'vitest'
import { parsePricingStatus, parseRateRows } from '@/features/admin/lib/pricing-data'
import { comSample, rateRow, rawRate, staleRow, status, statusJson } from './fixtures'

/**
 * What the Pricing & FX pages read, parsed (docs/ADMIN-SPEC.md §3.2h): an
 * answer of the wrong shape is refused rather than shown, and the example's
 * dollars become whole cents only when that is exactly the amount (D24).
 */

/** `admin_pricing_status()` as jsonb arrives: numerics as numbers, the example as SQL builds it. */
function answer() {
  return statusJson(status())
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
  /** The answer with its example changed as SQL might send it. */
  function withExample(example: Record<string, unknown> | null | undefined) {
    const json = answer()
    if (example === undefined) delete json.example
    else json.example = example === null ? null : { ...(json.example as object), ...example }
    const parsed = parsePricingStatus(json)
    if (!('status' in parsed)) throw new Error(`refused: ${JSON.stringify(parsed)}`)
    return parsed.status.example
  }

  it('reads .com in the cents SQL sends, and whether the storefront sells it (D24)', () => {
    expect(withExample({})).toEqual(comSample())
    expect(withExample({ isPaused: true })?.onSale).toBe(false)
    expect(withExample({ isSellable: false })?.onSale).toBe(false)
    expect(withExample({ registerPeriods: null, renewPeriods: [1, 2] })).toMatchObject({
      registerPeriods: null,
      renewPeriods: [1, 2],
    })
  })

  it('shows no example for a cost SQL could not give in whole cents, or no row (N5b)', () => {
    expect(withExample({ registerCents: null })).toBeNull()
    expect(withExample({ renewCents: null })).toBeNull()
    expect(withExample(null)).toBeNull()
    // A database before migration 42 sends none at all.
    expect(withExample(undefined)).toBeNull()
  })

  it('shows no example, and keeps the rest of the page, when it is malformed', () => {
    expect(withExample({ registerCents: 1131.5 })).toBeNull()
    expect(withExample({ renewCents: -1 })).toBeNull()
    expect(withExample({ name: '' })).toBeNull()
    expect(withExample({ minPeriod: '1' })).toBeNull()
  })
})
