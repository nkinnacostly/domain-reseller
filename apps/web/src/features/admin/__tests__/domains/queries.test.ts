import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDomainListParams } from '@/features/admin/lib/domains-params'
import {
  DomainsReadError,
  getDomain,
  getDomainStats,
  listDomains,
} from '@/features/admin/queries/domains'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { sessionClient } from '../foundation/fixtures'
import { fakeService, filterOf, ids, principal, type Read } from '../orders/fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const NOW = new Date('2026-10-03T12:00:00Z')

const byTable = (reads: Read[], table: string) => reads.filter((read) => read.table === table)

function session(options: Parameters<typeof sessionClient>[0] = {}) {
  const client = sessionClient(options)
  vi.mocked(createClient).mockResolvedValue(client.client as never)
  return client
}

const listRow = {
  id: ids.domain,
  domain_name: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  test_mode: true,
  user_id: ids.user,
  local_status: 'active',
  expires_at: '2027-03-01T10:00:00Z',
  auto_renew: true,
  transfer_lock: true,
  pending_transfer_lock: null,
  privacy_enabled: false,
  pending_privacy: null,
  delegation_status: 'verified',
  registry_status: 'Active',
  registry_checked_at: '2026-10-03T10:00:00Z',
  created_at: '2026-09-01T10:00:00Z',
}

const record = {
  ...listRow,
  order_item_id: ids.line,
  registered_at: '2026-03-01T10:00:00Z',
  updated_at: '2026-10-02T10:00:00Z',
  nameservers: ['ns1.example-dns.net', 'ns2.example-dns.net'],
  pending_nameservers: null,
  previous_nameservers: null,
  nameserver_preset_id: ids.payment,
  delegation_checked_at: '2026-10-03T11:30:00Z',
  registry_renewal_mode: 'AutoRenew',
  deep_checked_at: null,
  registrant_country: 'NG',
  registrant_type: 'individual',
}

beforeEach(() => vi.clearAllMocks())

describe('listDomains', () => {
  it('reads one page of the side through the masked view, demo rows left out, soonest expiry first', async () => {
    const admin = await principal({ testOnly: true })
    const reads = fakeService((read) =>
      read.table === 'admin_domains_v' ? { data: [listRow], count: 41 } : undefined,
    )

    const list = await listDomains(admin, 'live', parseDomainListParams({}), NOW)

    const [view] = byTable(reads, 'admin_domains_v')
    expect(view?.select).toBe(
      'id, domain_name, tld, source, test_mode, user_id, local_status, expires_at, auto_renew, transfer_lock, pending_transfer_lock, privacy_enabled, pending_privacy, delegation_status, registry_status, registry_checked_at, created_at',
    )
    expect(view?.options).toEqual({ count: 'exact' })
    // A test admin is always on the test side (D15), whatever was asked.
    expect(filterOf(view, 'eq', 'test_mode')).toBe(true)
    expect(filterOf(view, 'neq', 'source')).toBe('demo')
    expect(view?.filters).toContainEqual([
      'order',
      'expires_at',
      { ascending: true, nullsFirst: false },
    ])
    expect(view?.filters).toContainEqual(['range', 0, 24])
    expect(list.total).toBe(41)
    expect(list.rows).toEqual([
      {
        id: ids.domain,
        name: 'getpaid.com',
        tld: 'com',
        source: 'registration',
        testMode: true,
        userId: ids.user,
        status: 'active',
        expiresAt: '2027-03-01T10:00:00Z',
        autoRenew: true,
        transferLock: true,
        pendingTransferLock: null,
        privacy: false,
        pendingPrivacy: null,
        delegation: 'verified',
        registryStatus: 'Active',
        registryCheckedAt: '2026-10-03T10:00:00Z',
        createdAt: '2026-09-01T10:00:00Z',
      },
    ])
  })

  it('applies every filter in the URL, in SQL', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({ data: [] }))
    await listDomains(
      admin,
      'live',
      parseDomainListParams({
        status: 'active,redemption',
        tld: 'ng',
        source: 'transfer',
        delegation: 'failed',
        renew: 'off',
        expires: '30',
        from: '2026-09-01',
        to: '2026-09-30',
        q: 'GetPaid',
        sort: 'name',
        dir: 'desc',
        page: '2',
        per: '50',
      }),
      NOW,
    )
    const [view] = byTable(reads, 'admin_domains_v')
    expect(filterOf(view, 'eq', 'test_mode')).toBe(false)
    expect(filterOf(view, 'in', 'local_status')).toEqual(['active', 'redemption'])
    expect(filterOf(view, 'eq', 'tld')).toBe('ng')
    expect(filterOf(view, 'eq', 'source')).toBe('transfer')
    expect(filterOf(view, 'neq', 'source')).toBeUndefined()
    expect(filterOf(view, 'eq', 'delegation_status')).toBe('failed')
    expect(filterOf(view, 'eq', 'auto_renew')).toBe(false)
    expect(view?.filters).toContainEqual(['gte', 'expires_at', '2026-10-03T12:00:00.000Z'])
    expect(view?.filters).toContainEqual(['lte', 'expires_at', '2026-11-02T12:00:00.000Z'])
    expect(view?.filters).toContainEqual(['gte', 'created_at', '2026-09-01T00:00:00+01:00'])
    expect(view?.filters).toContainEqual(['lt', 'created_at', '2026-10-01T00:00:00+01:00'])
    expect(filterOf(view, 'ilike', 'domain_name')).toBe('%getpaid%')
    expect(view?.filters).toContainEqual([
      'order',
      'domain_name',
      { ascending: false, nullsFirst: false },
    ])
    expect(view?.filters).toContainEqual(['range', 50, 99])
  })

  it('reads expired domains as those before now, and auto-renew on as true', async () => {
    const admin = await principal()
    const reads = fakeService(() => ({ data: [] }))
    await listDomains(
      admin,
      'test',
      parseDomainListParams({ expires: 'expired', renew: 'on' }),
      NOW,
    )
    const [view] = byTable(reads, 'admin_domains_v')
    expect(view?.filters).toContainEqual(['lt', 'expires_at', '2026-10-03T12:00:00.000Z'])
    expect(filterOf(view, 'eq', 'auto_renew')).toBe(true)
  })

  it('fails as a whole, logging the code and never the search', async () => {
    const admin = await principal()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    fakeService(() => ({ error: { message: 'bad getpaid.com', code: '57014' } }))
    await expect(
      listDomains(admin, 'live', parseDomainListParams({ q: 'getpaid' }), NOW),
    ).rejects.toBeInstanceOf(DomainsReadError)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('getpaid')
    expect(warn).toHaveBeenCalledWith({ what: 'domains', code: '57014' }, expect.any(String))
  })
})

describe('getDomainStats', () => {
  const stats = {
    byTldStatus: [{ tld: 'com', status: 'active', count: 3 }],
    expiries: { expired: 1, d30: 2, d60: 2, d90: 3, autoOn90: 2, autoOff90: 1, next: null },
    delegation: [{ status: 'verified', count: 3 }],
    registryAutoRenewLabel: [{ mode: 'AutoRenew', count: 3 }],
  }

  it('asks admin_domain_stats for the side with the session client', async () => {
    const client = session({ rpc: { admin_domain_stats: { data: stats } } })
    expect(await getDomainStats('test')).toEqual(stats)
    expect(client.rpc).toHaveBeenCalledWith('admin_domain_stats', { p_test_mode: true })
  })

  it('refuses an error or an unexpected shape', async () => {
    session({ rpc: { admin_domain_stats: { error: { message: 'admin:test_admin' } } } })
    await expect(getDomainStats('live')).rejects.toBeInstanceOf(DomainsReadError)
    session({ rpc: { admin_domain_stats: { data: { byTldStatus: 'nope' } } } })
    await expect(getDomainStats('live')).rejects.toBeInstanceOf(DomainsReadError)
  })
})

describe('getDomain', () => {
  function answers(read: Read) {
    switch (read.table) {
      case 'admin_domains_v':
        return { data: [record] }
      case 'order_items':
        return {
          data: [
            {
              id: ids.line,
              order_id: ids.order,
              item_type: 'register',
              orders: { order_number: 'ND-001035' },
            },
          ],
        }
      case 'nameserver_presets':
        return { data: [{ id: ids.payment, provider: 'Vercel' }] }
      case 'jobs':
        return {
          data: [
            {
              id: ids.job,
              kind: 'register_domain',
              status: 'succeeded',
              last_error_code: null,
              attempts: 1,
              created_at: '2026-09-01T10:00:00Z',
              updated_at: '2026-09-01T10:05:00Z',
            },
          ],
          count: 12,
        }
      case 'domain_nameserver_history':
        return {
          data: [
            {
              id: 3,
              before: ['ns1.old.net'],
              after: ['ns1.example-dns.net'],
              changed_at: '2026-09-02T10:00:00Z',
            },
          ],
        }
      case 'registry_drift':
        return {
          data: [
            {
              id: 9,
              kind: 'supplier_renewed',
              detail: { ours: '2027-03-01T10:00:00Z', registry: '2028-03-01T10:00:00Z' },
              first_seen_at: '2026-10-01T10:00:00Z',
              last_seen_at: '2026-10-03T10:00:00Z',
              resolved_at: null,
            },
          ],
        }
      case 'domain_events':
        return {
          data: [
            {
              id: 5,
              event_type: 'registered',
              actor_type: 'system',
              created_at: '2026-09-01T10:05:00Z',
            },
          ],
        }
      case 'service_heartbeats':
        return { data: [{ name: 'gateway:ote', beat_at: '2026-10-03T11:58:00Z' }] }
      default:
        return undefined
    }
  }

  it('reads the domain from the masked view — never the registrant itself — and each part', async () => {
    const admin = await principal()
    const reads = fakeService(answers)

    const detail = await getDomain(admin, 'test', ids.domain)

    const [view] = byTable(reads, 'admin_domains_v')
    expect(view?.select).toContain('registrant_country, registrant_type')
    expect(view?.select).not.toMatch(/(^|[ ,])registrant([ ,]|$)/)
    expect(view?.select).not.toMatch(/(^|[ ,])contacts([ ,]|$)/)
    expect(filterOf(view, 'eq', 'id')).toBe(ids.domain)
    expect(filterOf(view, 'eq', 'test_mode')).toBe(true)
    expect(detail?.domain).toMatchObject({
      id: ids.domain,
      name: 'getpaid.com',
      registrantCountry: 'NG',
      registrantType: 'individual',
      presetId: ids.payment,
      nameservers: ['ns1.example-dns.net', 'ns2.example-dns.net'],
    })
    expect(detail?.line).toEqual({
      ok: true,
      data: { id: ids.line, orderId: ids.order, orderNumber: 'ND-001035', itemType: 'register' },
    })
    const [line] = byTable(reads, 'order_items')
    expect(line?.select).toBe(
      'id, order_id, item_type, orders(order_number), admin_side:orders!inner(test_mode)',
    )
    expect(detail?.preset).toEqual({ ok: true, data: { id: ids.payment, provider: 'Vercel' } })
    expect(detail?.jobs).toEqual({
      ok: true,
      data: {
        total: 12,
        rows: [
          {
            id: ids.job,
            kind: 'register_domain',
            status: 'succeeded',
            lastErrorCode: null,
            attempts: 1,
            createdAt: '2026-09-01T10:00:00Z',
            updatedAt: '2026-09-01T10:05:00Z',
          },
        ],
      },
    })
    expect(detail?.history).toEqual({
      ok: true,
      data: [
        {
          id: 3,
          before: ['ns1.old.net'],
          after: ['ns1.example-dns.net'],
          changedAt: '2026-09-02T10:00:00Z',
        },
      ],
    })
    expect(detail?.drift).toEqual({
      ok: true,
      data: [
        {
          id: 9,
          kind: 'supplier_renewed',
          ours: 'Expires 1 Mar 2027',
          registry: 'Expires 1 Mar 2028',
          firstSeenAt: '2026-10-01T10:00:00Z',
          lastSeenAt: '2026-10-03T10:00:00Z',
          resolvedAt: null,
        },
      ],
    })
    expect(detail?.events).toEqual({
      ok: true,
      data: [
        { id: 5, eventType: 'registered', actorType: 'system', createdAt: '2026-09-01T10:05:00Z' },
      ],
    })
    // The domain's own side names the heartbeat: a test domain needs the sandbox gateway.
    const [beat] = byTable(reads, 'service_heartbeats')
    expect(filterOf(beat, 'eq', 'name')).toBe('gateway:ote')
    expect(detail?.gateway).toEqual({ kind: 'read', beatAt: '2026-10-03T11:58:00Z' })
  })

  it('is null when the side has no such domain', async () => {
    const admin = await principal()
    fakeService(() => ({ data: [] }))
    expect(await getDomain(admin, 'live', ids.domain)).toBeNull()
  })

  it('never asks a test admin about the gateway, and reads no line or preset that is not there', async () => {
    const admin = await principal({ testOnly: true })
    const reads = fakeService((read) =>
      read.table === 'admin_domains_v'
        ? { data: [{ ...record, order_item_id: null, nameserver_preset_id: null }] }
        : { data: [] },
    )
    const detail = await getDomain(admin, 'test', ids.domain)
    expect(detail?.gateway).toEqual({ kind: 'hidden' })
    expect(detail?.line).toEqual({ ok: true, data: null })
    expect(detail?.preset).toEqual({ ok: true, data: null })
    expect(byTable(reads, 'service_heartbeats')).toHaveLength(0)
    expect(byTable(reads, 'order_items')).toHaveLength(0)
    expect(byTable(reads, 'nameserver_presets')).toHaveLength(0)
  })

  it('shows a part that failed as its own error, and the rest as read', async () => {
    const admin = await principal()
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    fakeService((read) => {
      if (read.table === 'jobs' || read.table === 'service_heartbeats') {
        return { error: { message: 'timeout', code: '57014' } }
      }
      return answers(read)
    })
    const detail = await getDomain(admin, 'live', ids.domain)
    expect(detail?.jobs).toEqual({ ok: false })
    expect(detail?.gateway).toEqual({ kind: 'failed' })
    expect(detail?.events.ok).toBe(true)
  })

  it('fails as a whole when the domain itself cannot be read', async () => {
    const admin = await principal()
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    fakeService(() => ({ error: { message: 'down', code: '08006' } }))
    await expect(getDomain(admin, 'live', ids.domain)).rejects.toBeInstanceOf(DomainsReadError)
  })
})
