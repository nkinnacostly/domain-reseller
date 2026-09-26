import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { lookupHost } from '../queries/dns'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('../queries/dns', () => ({ lookupHost: vi.fn() }))

const { requestNameservers, setAutoRenew } = await import('../actions/domains')

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001'
const now = () => Math.floor(Date.now() / 1000)

function userClient({
  owns = true,
  freshCode = true,
  status = 'active',
  source = 'registration',
  testMode = false,
  pending = null as string[] | null,
} = {}) {
  const domain = owns
    ? {
        id: DOMAIN_ID,
        domain_name: 'getpaid.com',
        source,
        test_mode: testMode,
        local_status: status,
        nameservers: null,
        pending_nameservers: pending,
      }
    : null
  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: {
            currentLevel: 'aal2',
            currentAuthenticationMethods: [
              { method: 'totp', timestamp: freshCode ? now() : now() - 3600 },
              { method: 'password', timestamp: now() - 3600 },
            ],
          },
        }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === 'domains' ? domain : null }),
          single: async () => ({ data: { password_reset_at: null } }),
        }),
      }),
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
}

let writes: { table: string; op: string; row: unknown }[]
let queueError: { message: string } | null
const VERCEL = '6c4f1a2e-3b5d-4e7f-8a9b-0c1d2e3f4a5b'
const HIDDEN = '7d5a2b3f-4c6e-4f80-9bac-1d2e3f4a5b6c'
const LIVE_DEFAULT = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SANDBOX_DEFAULT = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'
type PresetRow = {
  id: string
  is_hidden: boolean
  verified_at: string | null
  registrar_default_for?: string | null
}
/**
 * The presets the action may be sent — a visible host (read as a database
 * without migration 35's column returns it), a hidden one, and the
 * registrar's default on each side.
 */
const PRESETS: Record<string, PresetRow> = {
  [VERCEL]: { id: VERCEL, is_hidden: false, verified_at: '2026-09-23T00:00:00Z' },
  [HIDDEN]: { id: HIDDEN, is_hidden: true, verified_at: '2026-09-23T00:00:00Z' },
  [LIVE_DEFAULT]: {
    id: LIVE_DEFAULT,
    is_hidden: false,
    verified_at: '2026-09-26T00:00:00Z',
    registrar_default_for: 'live',
  },
  [SANDBOX_DEFAULT]: {
    id: SANDBOX_DEFAULT,
    is_hidden: false,
    verified_at: '2026-09-26T00:00:00Z',
    registrar_default_for: 'sandbox',
  },
}
beforeEach(() => {
  vi.clearAllMocks()
  writes = []
  queueError = null
  vi.mocked(createServiceClient).mockReturnValue({
    rpc: async (fn: string, args: unknown) => {
      writes.push({ table: fn, op: 'rpc', row: args })
      return { error: queueError }
    },
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => ({ data: PRESETS[id] ?? null, error: null }),
        }),
      }),
      update: (row: unknown) => ({
        eq: async () => {
          writes.push({ table, op: 'update', row })
          return { error: null }
        },
      }),
      insert: async (row: unknown) => {
        writes.push({ table, op: 'insert', row })
        return { error: null }
      },
    }),
  } as never)
  vi.mocked(lookupHost).mockResolvedValue('resolves')
})

describe('requestNameservers (FR-D1, FR-D4, SEC-2)', () => {
  it('needs a two-factor code from the last 15 minutes', async () => {
    userClient({ freshCode: false })
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.a.com\nns2.a.com',
    })
    expect(result?.serverError).toMatch(/Confirm it's you/)
    expect(writes).toEqual([])
  })

  it('refuses a domain that is not yours', async () => {
    userClient({ owns: false })
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.a.com\nns2.a.com',
    })
    expect(result?.data).toEqual({ error: 'That domain is not on your account.' })
    expect(writes).toEqual([])
  })

  it('blocks a typo before anything is saved', async () => {
    userClient()
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns1.whogohst.com' ? 'nxdomain' : 'resolves',
    )
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.whogohst.com\nns2.a.com',
    })
    expect(result?.data).toMatchObject({
      error: expect.any(String),
      details: ["ns1.whogohst.com doesn't exist — check the spelling."],
    })
    expect(writes).toEqual([])
  })

  it('records the requested set and a before/after event (FR-N5)', async () => {
    userClient()
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'NS1.Vercel-DNS.com ns2.vercel-dns.com',
    })
    expect(result?.data).toEqual({ ok: true, warnings: [], delivery: 'queued' })
    expect(writes).toEqual([
      {
        table: 'domains',
        op: 'update',
        row: {
          pending_nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
          nameserver_preset_id: null,
        },
      },
      {
        table: 'domain_events',
        op: 'insert',
        row: expect.objectContaining({
          event_type: 'nameservers_requested',
          payload: { before: null, after: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] },
        }),
      },
      { table: 'enqueue_nameserver_change', op: 'rpc', row: { p_domain_id: DOMAIN_ID } },
    ])
  })

  it.each([
    ['keeps a visible host preset', VERCEL, VERCEL],
    ['drops a hidden host preset (N11)', HIDDEN, null],
    ['drops a preset that does not exist', '8e6b3c4a-5d7f-4a91-8cbd-2e3f4a5b6c7d', null],
  ])('%s as the domain’s host label', async (_case, presetId, stored) => {
    userClient()
    await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.vercel-dns.com ns2.vercel-dns.com',
      presetId,
    })
    expect(writes[0]).toEqual({
      table: 'domains',
      op: 'update',
      row: {
        pending_nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
        nameserver_preset_id: stored,
      },
    })
  })

  it.each([
    ['keeps the live default ("Use default DNS") on a live domain', LIVE_DEFAULT, {}, LIVE_DEFAULT],
    [
      'keeps the sandbox default on a test-mode domain',
      SANDBOX_DEFAULT,
      { testMode: true },
      SANDBOX_DEFAULT,
    ],
    ['keeps the live default on a demo domain', LIVE_DEFAULT, { source: 'demo' }, LIVE_DEFAULT],
    ['drops the sandbox default on a live domain', SANDBOX_DEFAULT, {}, null],
    ['drops the live default on a test-mode domain', LIVE_DEFAULT, { testMode: true }, null],
  ])('%s (migration 35)', async (_case, presetId, domain, stored) => {
    userClient(domain)
    await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.registrar.test\nns2.registrar.test',
      presetId,
    })
    expect(writes[0]).toEqual({
      table: 'domains',
      op: 'update',
      row: {
        pending_nameservers: ['ns1.registrar.test', 'ns2.registrar.test'],
        nameserver_preset_id: stored,
      },
    })
  })

  it('sends nothing to a registry for a demo domain', async () => {
    userClient({ source: 'demo' })
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.vercel-dns.com ns2.vercel-dns.com',
    })
    expect(result?.data).toMatchObject({ ok: true, delivery: 'demo' })
    expect(writes.map((write) => write.op)).not.toContain('rpc')
  })

  it('holds a change for a domain still registering until registration applies it (FR-R5)', async () => {
    userClient({ status: 'pending' })
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.vercel-dns.com ns2.vercel-dns.com',
    })
    expect(result?.data).toMatchObject({ ok: true, delivery: 'after_registration' })
    expect(writes.map((write) => write.op)).not.toContain('rpc')
  })

  it('says so when the change could not be queued', async () => {
    userClient()
    queueError = { message: 'down' }
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.vercel-dns.com ns2.vercel-dns.com',
    })
    expect(result?.data).toEqual({ error: 'That change could not be saved. Please try again.' })
  })

  it('queues again when the same change is asked for twice', async () => {
    userClient({ pending: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] })
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.vercel-dns.com ns2.vercel-dns.com',
    })
    expect(result?.data).toMatchObject({ ok: true, unchanged: true })
    expect(writes).toEqual([
      { table: 'enqueue_nameserver_change', op: 'rpc', row: { p_domain_id: DOMAIN_ID } },
    ])
  })

  it('refuses a domain that is not active', async () => {
    userClient({ status: 'redemption' })
    const result = await requestNameservers({
      domainId: DOMAIN_ID,
      nameservers: 'ns1.a.com\nns2.a.com',
    })
    expect(result?.data).toEqual({ error: 'Nameservers can only be changed on an active domain.' })
  })
})

describe('setAutoRenew', () => {
  it('stores the preference and logs it', async () => {
    userClient()
    const result = await setAutoRenew({ domainId: DOMAIN_ID, autoRenew: false })
    expect(result?.data).toEqual({ ok: true })
    expect(writes.map((write) => [write.table, write.op])).toEqual([
      ['domains', 'update'],
      ['domain_events', 'insert'],
    ])
  })
})
