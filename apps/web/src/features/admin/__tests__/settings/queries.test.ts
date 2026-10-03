import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseExtensionsSearch } from '@/features/admin/lib/settings-params'
import {
  getDraft,
  getExtension,
  getFeaturedRanks,
  getHeldCounts,
  getLimits,
  getPreset,
  getPresetUsage,
  listAdmins,
  listDrafts,
  listExtensions,
  listPresets,
  listSslProducts,
} from '@/features/admin/queries/settings'
import { createClient } from '@/lib/supabase/server'
import { sessionClient } from '../foundation/fixtures'
import {
  draftRecord,
  fakeService,
  filterOf,
  ids,
  opsRow,
  presetRecord,
  principal,
  tldRow,
} from './fake-db'

/**
 * The Settings reads (docs/ADMIN-SPEC.md §5.2 B13, D4): `adminDb` rows with
 * plain columns, `admin_*` functions for the counts and the admins, and a
 * test admin kept away from `ops_settings`. A failed read answers null —
 * the page's error state — never a wrong number.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}))

type Rpc = NonNullable<Parameters<typeof sessionClient>[0]>['rpc']

function rpcs(rpc: Rpc) {
  const session = sessionClient({ rpc })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => vi.clearAllMocks())

describe('the limits', () => {
  it('reads ten columns, and the float alert already in cents from admin_float (D24)', async () => {
    const reads = fakeService(() => ({ data: opsRow() }))
    const session = rpcs({ admin_float: { data: { alertCents: 4_321, balanceCents: 1 } } })
    const admin = await principal({ role: 'owner' })
    expect(await getLimits(admin, 'live')).toEqual({
      auto_refund_max_kobo: 31_250_050,
      auto_refund_daily_max_kobo: 123_400_000,
      refund_delay_minutes: 17,
      stuck_order_minutes: 23,
      max_domains_per_account_day: 37,
      velocity_new_max: 4,
      velocity_trusted_max: 211,
      velocity_standard_after_days: 9,
      velocity_trusted_after_days: 41,
      velocity_trusted_after_paid_orders: 6,
      float_alert_cents: 4_321,
    })
    expect(reads[0]?.table).toBe('ops_settings')
    // No dollar figure is read under features/admin.
    expect(reads[0]?.select).not.toMatch(/_usd/)
    expect(session.rpc).toHaveBeenCalledWith('admin_float', { p_test_mode: false })
  })

  it('shows a test admin none, and never asks', async () => {
    const reads = fakeService(() => ({ data: opsRow() }))
    const session = rpcs({ admin_float: { data: { alertCents: 1 } } })
    expect(await getLimits(await principal({ testOnly: true, role: 'operator' }), 'test')).toBe(
      'hidden',
    )
    expect(reads).toHaveLength(0)
    expect(session.rpc).not.toHaveBeenCalledWith('admin_float', expect.anything())
  })

  it('answers null for a failed read, a missing row or a shape it cannot trust', async () => {
    const admin = await principal()
    rpcs({ admin_float: { data: { alertCents: 4_321 } } })
    fakeService(() => ({ error: { message: 'timeout', code: '57014' } }))
    expect(await getLimits(admin, 'live')).toBeNull()
    fakeService(() => ({ data: null }))
    expect(await getLimits(admin, 'live')).toBeNull()
    fakeService(() => ({ data: opsRow({ refund_delay_minutes: 'ten' }) }))
    expect(await getLimits(admin, 'live')).toBeNull()
    fakeService(() => ({ data: opsRow() }))
    rpcs({ admin_float: { data: { alertCents: 43.21 } } })
    expect(await getLimits(admin, 'live')).toBeNull()
    rpcs({ admin_float: { error: { message: 'admin:needs_code' } } })
    expect(await getLimits(admin, 'live')).toBeNull()
  })
})

describe('the extensions', () => {
  it('filters by name and state chips, sorts, pages and counts', async () => {
    const reads = fakeService(() => ({ data: [tldRow()], count: 1 }))
    const admin = await principal()
    const page = await listExtensions(
      admin,
      'live',
      parseExtensionsSearch({ q: 'af', status: 'paused,featured', sort: 'rank', page: '2' }),
    )
    expect(page).toEqual({
      total: 1,
      rows: [
        {
          name: 'africa',
          isSellable: true,
          isPaused: false,
          pausedReason: null,
          featuredRank: 4,
          featuredTagline: 'For the continent',
          isCountryCode: false,
          isTransferable: true,
          syncedAt: '2026-10-01T09:00:00Z',
        },
      ],
    })
    const read = reads[0]
    expect(read?.table).toBe('tlds')
    expect(read?.options).toEqual({ count: 'exact' })
    expect(filterOf(read, 'ilike', 'name')).toBe('af%')
    expect(read?.filters).toContainEqual(['or', 'is_paused.eq.true,featured_rank.not.is.null'])
    expect(read?.filters).toContainEqual([
      'order',
      'featured_rank',
      { ascending: true, nullsFirst: false },
    ])
    expect(read?.filters).toContainEqual(['order', 'name', { ascending: true }])
    expect(read?.filters).toContainEqual(['range', 50, 99])
  })

  it('sorts by name alone by default, and by sync time when asked', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal()
    await listExtensions(
      admin,
      'live',
      parseExtensionsSearch({ sort: 'synced', status: 'unsold,country' }),
    )
    expect(reads[0]?.filters).toContainEqual([
      'order',
      'synced_at',
      { ascending: true, nullsFirst: false },
    ])
    expect(reads[0]?.filters).toContainEqual(['or', 'is_sellable.eq.false,is_country_code.eq.true'])
    await listExtensions(admin, 'live', parseExtensionsSearch({ dir: 'desc' }))
    expect(reads[1]?.filters.filter(([method]) => method === 'order')).toEqual([
      ['order', 'name', { ascending: false }],
    ])
  })

  it('counts instead past the last page, and answers null when it cannot', async () => {
    const admin = await principal()
    fakeService((read) =>
      read.options?.head ? { count: 706 } : { error: { message: 'range', code: 'PGRST103' } },
    )
    expect(await listExtensions(admin, 'live', parseExtensionsSearch({ page: '99' }))).toEqual({
      rows: [],
      total: 706,
    })
    fakeService((read) =>
      read.options?.head
        ? { error: { message: 'boom' } }
        : { error: { message: 'range', code: 'PGRST103' } },
    )
    expect(await listExtensions(admin, 'live', parseExtensionsSearch({ page: '99' }))).toBeNull()
    fakeService(() => ({ error: { message: 'boom' } }))
    expect(await listExtensions(admin, 'live', parseExtensionsSearch({}))).toBeNull()
  })

  it('reads one extension by name, or says there is none', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({
      data: tldRow({ is_transferable: null, featured_rank: null }),
    }))
    expect(await getExtension(admin, 'live', 'africa')).toMatchObject({
      name: 'africa',
      featuredRank: null,
      isTransferable: null,
    })
    expect(filterOf(reads[0], 'eq', 'name')).toBe('africa')
    fakeService(() => ({ data: null }))
    expect(await getExtension(admin, 'live', 'nope')).toBeNull()
    fakeService(() => ({ error: { message: 'boom' } }))
    expect(await getExtension(admin, 'live', 'africa')).toBe('error')
  })

  it('lists every featured rank, and null when it cannot', async () => {
    const admin = await principal()
    fakeService(() => ({
      data: [
        { name: 'com', featured_rank: 1 },
        { name: 'africa', featured_rank: 4 },
      ],
    }))
    expect(await getFeaturedRanks(admin, 'live')).toEqual([
      { name: 'com', rank: 1 },
      { name: 'africa', rank: 4 },
    ])
    fakeService(() => ({ error: { message: 'boom' } }))
    expect(await getFeaturedRanks(admin, 'live')).toBeNull()
  })

  it('counts held domains per extension on the side asked for', async () => {
    const session = rpcs({
      admin_tld_held_counts: {
        data: [
          { tld: 'com', held: 6 },
          { tld: 'ng', held: '2' },
          { tld: null, held: 1 },
        ],
      },
    })
    const counts = await getHeldCounts('test')
    expect(session.rpc).toHaveBeenCalledWith('admin_tld_held_counts', { p_test_mode: true })
    expect(counts?.get('com')).toBe(6)
    expect(counts?.get('ng')).toBe(2)
    expect(counts?.size).toBe(2)
    rpcs({ admin_tld_held_counts: { error: { message: 'admin:test_admin' } } })
    expect(await getHeldCounts('live')).toBeNull()
  })
})

describe('the SSL products', () => {
  it('lists every product, and which have a price, without reading a dollar figure', async () => {
    const reads = fakeService((read) =>
      read.select === 'product_code'
        ? { data: [{ product_code: '382' }] }
        : {
            data: [
              {
                product_code: '351',
                name: 'Sectigo PositiveSSL Certificate',
                vendor: 'Sectigo',
                validation_type: 'dv',
                is_wildcard: false,
                is_multi_domain: null,
                included_names: 1,
                max_names: null,
                is_sellable: true,
                synced_at: '2026-10-01T09:00:00Z',
              },
              { product_code: '382', name: null, is_sellable: false },
            ],
          },
    )
    const products = await listSslProducts(await principal(), 'live')
    expect(products?.map((row) => [row.productCode, row.hasPrice, row.isSellable])).toEqual([
      ['351', true, true],
      ['382', false, false],
    ])
    expect(products?.[0]).toMatchObject({ isMultiDomain: null, includedNames: 1, maxNames: null })
    expect(reads.every((read) => !read.select?.includes('_usd'))).toBe(true)
    expect(reads[1]?.filters).toContainEqual(['is', 'create_usd', null])
  })

  it('answers null when either read fails', async () => {
    fakeService((read) => (read.select === 'product_code' ? { error: { message: 'boom' } } : {}))
    expect(await listSslProducts(await principal(), 'live')).toBeNull()
  })
})

describe('the presets and their drafts', () => {
  it('lists presets with their recorded check kept to hosts and verdicts', async () => {
    const reads = fakeService(() => ({ data: [presetRecord()] }))
    const [preset] = (await listPresets(await principal(), 'live')) ?? []
    expect(preset).toMatchObject({
      id: ids.preset,
      provider: 'Example Host',
      assignsPerZone: false,
      lastCheck: {
        unresolved: [],
        hosts: [
          { host: 'ns1.example-host.test', verdict: 'resolves' },
          { host: 'ns2.example-host.test', verdict: 'resolves' },
        ],
      },
    })
    expect(reads[0]?.table).toBe('nameserver_presets')
    fakeService(() => ({ error: { message: 'boom' } }))
    expect(await listPresets(await principal(), 'live')).toBeNull()
  })

  it('reads one preset, none, or an error', async () => {
    const admin = await principal()
    fakeService(() => ({ data: presetRecord({ last_check: null, nameservers: null }) }))
    expect(await getPreset(admin, 'live', ids.preset)).toMatchObject({
      lastCheck: null,
      nameservers: [],
    })
    fakeService(() => ({ data: null }))
    expect(await getPreset(admin, 'live', ids.preset)).toBeNull()
    fakeService(() => ({ error: { message: 'boom' } }))
    expect(await getPreset(admin, 'live', ids.preset)).toBe('error')
  })

  it("reads open drafts for the list, and one preset's for its page — a test admin too (§9 B13)", async () => {
    const reads = fakeService(() => ({ data: [draftRecord({ check_ok: true })] }))
    const admin = await principal({ testOnly: true, role: 'operator' })
    const [draft] = (await listDrafts(admin, 'test', { open: true })) ?? []
    expect(draft).toMatchObject({ id: ids.draft, checkOk: true, notes: 'Moved in October' })
    expect(reads[0]?.table).toBe('nameserver_preset_drafts')
    expect(reads[0]?.filters).toContainEqual(['is', 'published_at', null])
    expect(reads[0]?.filters).toContainEqual(['is', 'discarded_at', null])
    await listDrafts(admin, 'test', { presetId: ids.preset })
    expect(filterOf(reads[1], 'eq', 'preset_id')).toBe(ids.preset)
    fakeService(() => ({ error: { message: 'boom' } }))
    expect(await listDrafts(admin, 'test', { open: true })).toBeNull()
  })

  it('reads one draft, none, or an error', async () => {
    const admin = await principal()
    fakeService(() => ({ data: draftRecord({ preset_id: null }) }))
    expect(await getDraft(admin, 'live', ids.draft)).toMatchObject({ presetId: null })
    fakeService(() => ({ data: null }))
    expect(await getDraft(admin, 'live', ids.draft)).toBeNull()
    fakeService(() => ({ error: { message: 'boom' } }))
    expect(await getDraft(admin, 'live', ids.draft)).toBe('error')
  })

  it('counts who uses each preset on the side asked for', async () => {
    const session = rpcs({
      admin_preset_usage: {
        data: [
          { preset_id: ids.preset, domains: 3, orders: '1', lines: 2 },
          { preset_id: null, domains: 1, orders: 0, lines: 0 },
        ],
      },
    })
    const usage = await getPresetUsage('live')
    expect(session.rpc).toHaveBeenCalledWith('admin_preset_usage', { p_test_mode: false })
    expect(usage?.get(ids.preset)).toEqual({ domains: 3, orders: 1, lines: 2 })
    expect(usage?.size).toBe(1)
    rpcs({ admin_preset_usage: { error: { message: 'boom' } } })
    expect(await getPresetUsage('live')).toBeNull()
  })
})

describe('the admins', () => {
  it('lists labels, roles and devices — no id, no email', async () => {
    const session = rpcs({
      admin_list_admins: {
        data: [
          {
            label: 'e2e-1a2b3c4d',
            role: 'operator',
            test_only: true,
            added_at: '2026-10-03T12:00:00Z',
            revoked_at: null,
            pinned_factors: 1,
            verified_pinned_factors: 1,
            last_change_at: '2026-10-03T12:00:00Z',
          },
        ],
      },
    })
    expect(await listAdmins()).toEqual([
      {
        label: 'e2e-1a2b3c4d',
        role: 'operator',
        testOnly: true,
        addedAt: '2026-10-03T12:00:00Z',
        revokedAt: null,
        pinnedFactors: 1,
        verifiedPinnedFactors: 1,
        lastChangeAt: '2026-10-03T12:00:00Z',
      },
    ])
    expect(session.rpc).toHaveBeenCalledWith('admin_list_admins')
    rpcs({ admin_list_admins: { error: { message: 'admin:not_admin' } } })
    expect(await listAdmins()).toBeNull()
  })
})
