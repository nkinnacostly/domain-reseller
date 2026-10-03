import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCurrentRates,
  getPricingStatus,
  getRecentRates,
  getSampleTld,
  getSettingsChangedAt,
  RECENT_RATES,
  SAMPLE_TLD,
} from '@/features/admin/queries/pricing'
import { adminWhoami } from '@/features/admin/queries/session'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'
import { fakeService, rateRow, rawRate, staleRow, status } from './fixtures'

/**
 * The Pricing & FX reads (docs/ADMIN-SPEC.md §3.2h, §5.2 B12): one SQL
 * function called as the admin, and storefront-public rows through adminDb
 * — select only, named columns, never a write. A read that fails or answers
 * the wrong shape is null, so the page shows its error state, never a guess.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}))

function session(rpc: NonNullable<Parameters<typeof sessionClient>[0]>['rpc'] = {}) {
  const client = sessionClient({ rpc })
  vi.mocked(createClient).mockResolvedValue(client.client as never)
  return client
}

async function principal(overrides: Record<string, unknown> = {}) {
  const client = sessionClient({ rpc: { admin_whoami: { data: whoami(overrides) } } })
  return adminWhoami(client.client as never, null)
}

const SAMPLE_ROW = {
  name: 'com',
  register_usd: 11.31,
  renew_usd: 11.51,
  is_country_code: false,
  min_period: 1,
  max_period: 10,
  register_periods: [1, 2],
  renew_periods: [1],
  is_sellable: true,
  is_paused: false,
}

beforeEach(() => vi.clearAllMocks())

describe('getPricingStatus', () => {
  it('asks admin_pricing_status as the admin, and parses its answer', async () => {
    const client = session({
      admin_pricing_status: { data: JSON.parse(JSON.stringify(status())) },
    })
    expect(await getPricingStatus()).toEqual(status())
    expect(client.rpc).toHaveBeenCalledWith('admin_pricing_status')
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('is null when SQL refuses or answers another shape', async () => {
    session({ admin_pricing_status: { error: { message: 'admin:needs_code' } } })
    expect(await getPricingStatus()).toBeNull()
    session({ admin_pricing_status: { data: { tlds: 'all of them' } } })
    expect(await getPricingStatus()).toBeNull()
  })
})

describe('the rate reads', () => {
  it('reads the active and held rates, whole, through adminDb', async () => {
    const calls = fakeService({ fx_rates: { data: [rawRate(staleRow()), rawRate(rateRow())] } })
    expect(await getCurrentRates(await principal())).toEqual([staleRow(), rateRow()])
    expect(calls).toEqual([
      ['from', 'fx_rates'],
      [
        'select',
        'id, status, source, costing_rate, buffer_pct, move_pct, review_reason, quoted_at, effective_from, created_at, reviewed_at',
        undefined,
      ],
      ['in', 'status', ['active', 'pending_review']],
      ['order', 'quoted_at', { ascending: false }],
    ])
  })

  it('reads the latest rates, newest first, for a test administrator too', async () => {
    const calls = fakeService({ fx_rates: { data: [rawRate(rateRow())] } })
    const testAdmin = await principal({ role: 'operator', testOnly: true, label: 'e2e-1' })
    expect(await getRecentRates(testAdmin)).toEqual([rateRow()])
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(calls).toContainEqual(['limit', RECENT_RATES])
    expect(RECENT_RATES).toBe(10)
  })

  it('is null on an error, a refusal or a row of another shape', async () => {
    const admin = await principal()
    fakeService({ fx_rates: { error: { code: '57014', message: 'statement timeout' } } })
    expect(await getCurrentRates(admin)).toBeNull()
    expect(await getRecentRates(admin)).toBeNull()
    fakeService({ fx_rates: { data: [{ id: 'x' }] } })
    expect(await getCurrentRates(admin)).toBeNull()
    expect(await getRecentRates(admin)).toBeNull()
    // adminDb refuses anything but a principal it issued.
    expect(await getCurrentRates({ role: 'owner' } as never)).toBeNull()
    expect(await getRecentRates({ role: 'owner' } as never)).toBeNull()
  })
})

describe('getSampleTld', () => {
  it('reads .com’s row through adminDb and turns its dollars into cents', async () => {
    const calls = fakeService({ tlds: { data: [SAMPLE_ROW] } })
    expect(SAMPLE_TLD).toBe('com')
    expect(await getSampleTld(await principal())).toMatchObject({
      name: 'com',
      registerCents: 1131,
      renewCents: 1151,
      onSale: true,
    })
    expect(calls).toContainEqual(['eq', 'name', 'com'])
    expect(calls).toContainEqual(['limit', 1])
  })

  it('is null without the row, on an error or a refusal', async () => {
    const admin = await principal()
    fakeService({ tlds: { data: [] } })
    expect(await getSampleTld(admin)).toBeNull()
    fakeService({ tlds: { data: null, error: { code: 'PGRST301', message: 'no' } } })
    expect(await getSampleTld(admin)).toBeNull()
    expect(await getSampleTld({} as never)).toBeNull()
  })
})

describe('getSettingsChangedAt', () => {
  it('reads when the settings last changed, and nothing else', async () => {
    const calls = fakeService({
      pricing_settings: { data: [{ updated_at: '2026-09-20T19:44:56.567115+00:00' }] },
    })
    expect(await getSettingsChangedAt(await principal())).toBe('2026-09-20T19:44:56.567115+00:00')
    expect(calls).toEqual([
      ['from', 'pricing_settings'],
      ['select', 'updated_at', undefined],
      ['limit', 1],
    ])
  })

  it('is null without a row, on an error or a refusal', async () => {
    const admin = await principal()
    fakeService({ pricing_settings: { data: [] } })
    expect(await getSettingsChangedAt(admin)).toBeNull()
    fakeService({ pricing_settings: { error: { code: '57014', message: 'timeout' } } })
    expect(await getSettingsChangedAt(admin)).toBeNull()
    expect(await getSettingsChangedAt({} as never)).toBeNull()
  })
})
