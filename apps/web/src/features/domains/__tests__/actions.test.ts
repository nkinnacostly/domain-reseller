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
  pending = null as string[] | null,
} = {}) {
  const domain = owns
    ? {
        id: DOMAIN_ID,
        domain_name: 'getpaid.com',
        source,
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
