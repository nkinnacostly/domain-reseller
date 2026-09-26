import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/public', () => ({ createPublicClient: vi.fn() }))

const { createClient } = await import('@/lib/supabase/server')
const { createPublicClient } = await import('@/lib/supabase/public')
const { cacheLife, cacheTag } = await import('next/cache')
const {
  getDomain,
  getDomainEvents,
  getNameserverPresets,
  getPortfolio,
  getRecentActivity,
  getRegistrarDefault,
} = await import('../queries/domains')

type Call = [method: string, ...args: unknown[]]

/**
 * A stand-in for the Supabase query builder: every chained call is recorded
 * and returns the same thenable, which resolves to `{ data }` for the table —
 * or `{ error }` for a table named in `errors`.
 */
function supabase(tables: Record<string, unknown>, errors: Record<string, string> = {}) {
  const calls: Record<string, Call[]> = {}
  const from = vi.fn((table: string) => {
    const log: Call[] = []
    calls[table] = log
    const failure = errors[table]
    const query: Record<string, unknown> = Object.assign(
      Promise.resolve(
        failure
          ? { data: null, error: { message: failure } }
          : { data: tables[table] ?? null, error: null },
      ),
      Object.fromEntries(
        ['select', 'eq', 'order', 'limit', 'maybeSingle'].map((method) => [
          method,
          (...args: unknown[]) => {
            log.push([method, ...args])
            return query
          },
        ]),
      ),
    )
    return query
  })
  return { client: { from }, calls }
}

const ROW = {
  id: 'dom-1',
  domain_name: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  test_mode: false,
  local_status: 'active',
  expires_at: '2027-09-23T08:44:10.000Z',
  registered_at: '2026-09-23T08:44:10.000Z',
  auto_renew: true,
  privacy_enabled: true,
  transfer_lock: true,
  delegation_status: 'verified',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  pending_nameservers: null,
  nameserver_preset_id: 'preset-vercel',
  registrant: { name: 'Ada Okafor' },
  created_at: '2026-09-23T08:40:00.000Z',
}

const PORTFOLIO_ROW = {
  id: 'dom-1',
  domainName: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  testMode: false,
  status: 'active',
  expiresAt: '2027-09-23T08:44:10.000Z',
  autoRenew: true,
  privacyEnabled: true,
  transferLock: true,
  delegationStatus: 'verified',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  pendingNameservers: null,
  labels: [],
}

function signedIn(tables: Record<string, unknown>) {
  const fake = supabase(tables)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake.calls
}

beforeEach(() => vi.clearAllMocks())

describe('getPortfolio (FR-P2)', () => {
  it('turns each of the account’s rows into a portfolio row, by name', async () => {
    const calls = signedIn({ domains: [ROW] })
    expect(await getPortfolio()).toEqual([PORTFOLIO_ROW])
    expect(calls.domains).toContainEqual(['order', 'domain_name'])
  })

  it('shows an empty portfolio, not an error, when the read returns nothing', async () => {
    signedIn({ domains: null })
    expect(await getPortfolio()).toEqual([])
  })
})

describe('getRecentActivity (FR-P6)', () => {
  it('reads the newest events first, with the domain each belongs to', async () => {
    const calls = signedIn({
      domain_events: [
        {
          id: '42',
          event_type: 'nameservers_applied',
          payload: { nameservers: ['ns1.vercel-dns.com'] },
          created_at: '2026-09-23T10:00:00.000Z',
          domains: { domain_name: 'getpaid.com' },
        },
        {
          id: '41',
          event_type: 'auto_renew_on',
          payload: null,
          created_at: '2026-09-22T10:00:00.000Z',
          domains: { domain_name: 'naija.ng' },
        },
      ],
    })

    expect(await getRecentActivity(2)).toEqual([
      {
        id: 42,
        type: 'nameservers_applied',
        payload: { nameservers: ['ns1.vercel-dns.com'] },
        createdAt: '2026-09-23T10:00:00.000Z',
        domainName: 'getpaid.com',
      },
      {
        id: 41,
        type: 'auto_renew_on',
        payload: {},
        createdAt: '2026-09-22T10:00:00.000Z',
        domainName: 'naija.ng',
      },
    ])
    expect(calls.domain_events).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(calls.domain_events).toContainEqual(['limit', 2])
  })

  it('asks for six by default, and copes with no events at all', async () => {
    const calls = signedIn({ domain_events: null })
    expect(await getRecentActivity()).toEqual([])
    expect(calls.domain_events).toContainEqual(['limit', 6])
  })
})

describe('getDomain (the URL segment)', () => {
  it('finds a domain whatever the case or encoding of the address bar', async () => {
    const calls = signedIn({
      domains: { ...ROW, order_items: { failure_code: null, renewal_kobo: 1_870_000 } },
    })
    const domain = await getDomain('GetPaid%2Ecom')

    expect(calls.domains).toContainEqual(['eq', 'domain_name', 'getpaid.com'])
    expect(domain).toEqual({
      ...PORTFOLIO_ROW,
      registeredAt: '2026-09-23T08:44:10.000Z',
      transferLock: true,
      presetId: 'preset-vercel',
      registrant: { name: 'Ada Okafor' },
      failureCode: null,
      promisedRenewalKobo: 1_870_000,
    })
  })

  it('says why a registration failed when the order line recorded it', async () => {
    signedIn({
      domains: {
        ...ROW,
        local_status: 'registration_failed',
        order_items: { failure_code: 'DOMAIN_TAKEN' },
      },
    })
    const domain = await getDomain('taken.com')
    expect(domain?.status).toBe('registration_failed')
    expect(domain?.failureCode).toBe('DOMAIN_TAKEN')
  })

  it('has no failure code for a domain added without an order', async () => {
    signedIn({ domains: { ...ROW, source: 'demo', order_items: null } })
    expect((await getDomain('demo.com'))?.failureCode).toBeNull()
  })

  it('returns nothing for a domain that is not the user’s', async () => {
    signedIn({ domains: null })
    expect(await getDomain('someone-else.com')).toBeNull()
  })
})

describe('getDomainEvents (FR-N5)', () => {
  it('reads one domain’s history, newest first', async () => {
    const events = [
      {
        id: 2,
        event_type: 'nameservers_requested',
        actor_type: 'user',
        payload: {},
        created_at: '2026-09-23T10:00:00.000Z',
      },
    ]
    const calls = signedIn({ domain_events: events })

    expect(await getDomainEvents('dom-1')).toEqual(events)
    expect(calls.domain_events).toContainEqual(['eq', 'domain_id', 'dom-1'])
    expect(calls.domain_events).toContainEqual(['order', 'created_at', { ascending: false }])
  })

  it('is an empty history when the read returns nothing', async () => {
    signedIn({ domain_events: null })
    expect(await getDomainEvents('dom-1')).toEqual([])
  })
})

describe('getNameserverPresets (FR-D2)', () => {
  it('reads the verified presets through the cookie-free client, cached and tagged', async () => {
    const fake = supabase({
      nameserver_presets: [
        {
          id: 'preset-vercel',
          provider: 'Vercel',
          nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
          assigns_per_zone: false,
          notes: 'Add the domain in Vercel first.',
          source_url: 'https://vercel.com/docs/domains',
        },
      ],
    })
    vi.mocked(createPublicClient).mockReturnValue(fake.client as never)

    expect(await getNameserverPresets()).toEqual([
      {
        id: 'preset-vercel',
        provider: 'Vercel',
        nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
        assignsPerZone: false,
        notes: 'Add the domain in Vercel first.',
        sourceUrl: 'https://vercel.com/docs/domains',
      },
    ])
    expect(createClient).not.toHaveBeenCalled()
    expect(cacheTag).toHaveBeenCalledWith('nameserver-presets')
    expect(cacheLife).toHaveBeenCalledWith('hours')
  })

  it('offers no presets, rather than failing the page, when none can be read', async () => {
    vi.mocked(createPublicClient).mockReturnValue(
      supabase({ nameserver_presets: null }).client as never,
    )
    expect(await getNameserverPresets()).toEqual([])
  })

  it('never lists the registrar’s own defaults as hosts (migration 35)', async () => {
    const preset = (provider: string, registrarDefaultFor: string | null) => ({
      id: `preset-${provider}`,
      provider,
      nameservers: ['ns1.example.test', 'ns2.example.test'],
      assigns_per_zone: false,
      notes: null,
      source_url: 'https://example.test/docs',
      registrar_default_for: registrarDefaultFor,
    })
    const fake = supabase({
      nameserver_presets: [
        preset('Hostinger', null),
        preset('Registrar default (live)', 'live'),
        preset('Registrar default (sandbox)', 'sandbox'),
        preset('Vercel', null),
      ],
    })
    vi.mocked(createPublicClient).mockReturnValue(fake.client as never)

    expect((await getNameserverPresets()).map((host) => host.provider)).toEqual([
      'Hostinger',
      'Vercel',
    ])
    // Every column, so a database without the new one still lists its hosts.
    expect(fake.calls.nameserver_presets).toContainEqual(['select', '*'])
  })
})

describe('getRegistrarDefault (migration 35)', () => {
  const DEFAULT = {
    id: 'preset-default',
    provider: 'Registrar default (sandbox)',
    nameservers: ['tr.example.test', 'eu.example.test'],
    assigns_per_zone: false,
    notes: 'Not a host.',
    source_url: 'https://example.test',
  }

  it('reads the default for the domain’s side through the cookie-free client, cached', async () => {
    const fake = supabase({ nameserver_presets: DEFAULT })
    vi.mocked(createPublicClient).mockReturnValue(fake.client as never)

    expect(await getRegistrarDefault('sandbox')).toEqual({
      id: 'preset-default',
      provider: 'Registrar default (sandbox)',
      nameservers: ['tr.example.test', 'eu.example.test'],
      assignsPerZone: false,
      notes: 'Not a host.',
      sourceUrl: 'https://example.test',
    })
    expect(fake.calls.nameserver_presets).toContainEqual(['eq', 'registrar_default_for', 'sandbox'])
    expect(fake.calls.nameserver_presets).toContainEqual(['maybeSingle'])
    expect(createClient).not.toHaveBeenCalled()
    expect(cacheTag).toHaveBeenCalledWith('nameserver-presets')
    expect(cacheLife).toHaveBeenCalledWith('hours')
  })

  it('has none to offer when the side has no default, hidden or never added', async () => {
    vi.mocked(createPublicClient).mockReturnValue(
      supabase({ nameserver_presets: null }).client as never,
    )
    expect(await getRegistrarDefault('live')).toBeNull()
  })

  it('has none to offer, rather than failing the page, when it cannot be read', async () => {
    vi.mocked(createPublicClient).mockReturnValue(
      supabase({}, { nameserver_presets: 'column does not exist' }).client as never,
    )
    expect(await getRegistrarDefault('live')).toBeNull()
  })

  it('offers nothing for a row with no fixed set to fill in', async () => {
    vi.mocked(createPublicClient).mockReturnValue(
      supabase({ nameserver_presets: { ...DEFAULT, nameservers: [], assigns_per_zone: true } })
        .client as never,
    )
    expect(await getRegistrarDefault('sandbox')).toBeNull()
  })
})
