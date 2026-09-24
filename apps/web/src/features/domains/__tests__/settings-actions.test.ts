import { HttpResponse, http } from 'msw'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { server } from '../../../../tests/mocks/server'

// env.ts reads process.env once, at import: point it at a test gateway first.
vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const { changeRegistrant, lockTransfers, revealTransferCode, setPrivacy, unlockTransfers } =
  await import('../actions/settings')

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001'
const CODE = 'Zx9!secret-code'
const now = () => Math.floor(Date.now() / 1000)

const ADA = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
/** The registrant as the form sends it: every field a string. */
const form = (over: Partial<typeof ADA & { company: string }> = {}) => ({
  company: '',
  addressLine2: '',
  ...ADA,
  ...over,
})

type Row = Record<string, unknown>
const DOMAIN: Row = {
  id: DOMAIN_ID,
  domain_name: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  test_mode: false,
  local_status: 'active',
  transfer_lock: true,
  privacy_enabled: false,
  registrant: ADA,
  pending_transfer_lock: null,
  pending_privacy: null,
  pending_registrant: null,
}

function userClient({ owns = true, freshCode = true, domain = {} as Row } = {}) {
  const row = owns ? { ...DOMAIN, ...domain } : null
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
          maybeSingle: async () => ({ data: table === 'domains' ? row : null }),
          single: async () => ({ data: { password_reset_at: null } }),
        }),
      }),
    }),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
}

let writes: { table: string; op: string; row: unknown }[]
let failing: Set<string>
let withinLimit: boolean

beforeEach(() => {
  vi.clearAllMocks()
  writes = []
  failing = new Set()
  withinLimit = true
  vi.mocked(createServiceClient).mockReturnValue({
    rpc: async (fn: string, args: unknown) => {
      if (fn === 'rate_limit_hit') return { data: withinLimit, error: null }
      writes.push({ table: fn, op: 'rpc', row: args })
      return { error: failing.has(fn) ? { message: 'down' } : null }
    },
    from: (table: string) => ({
      update: (row: unknown) => ({
        eq: async () => {
          writes.push({ table, op: 'update', row })
          return { error: failing.has(`update:${table}`) ? { message: 'down' } : null }
        },
      }),
      insert: async (row: unknown) => {
        writes.push({ table, op: 'insert', row })
        return { error: failing.has(`insert:${table}`) ? { message: 'down' } : null }
      },
    }),
  } as never)
})

const queued = (kind: string) => ({
  table: 'enqueue_domain_change',
  op: 'rpc',
  row: { p_domain_id: DOMAIN_ID, p_kind: kind },
})

describe('unlockTransfers (FR-DS4, SEC-2)', () => {
  it('needs a two-factor code from the last 15 minutes, and saves nothing without one', async () => {
    userClient({ freshCode: false })
    const result = await unlockTransfers({ domainId: DOMAIN_ID })
    expect(result?.serverError).toMatch(/Confirm it's you/)
    expect(writes).toEqual([])
  })

  it('refuses a domain that is not yours', async () => {
    userClient({ owns: false })
    expect((await unlockTransfers({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: 'That domain is not on your account.',
    })
    expect(writes).toEqual([])
  })

  it('never sends a demo domain to a registry', async () => {
    userClient({ domain: { source: 'demo' } })
    expect((await unlockTransfers({ domainId: DOMAIN_ID }))?.data).toMatchObject({
      error: expect.stringMatching(/not registered anywhere/),
    })
    expect(writes).toEqual([])
  })

  it('refuses a domain still registering', async () => {
    userClient({ domain: { local_status: 'pending' } })
    expect((await unlockTransfers({ domainId: DOMAIN_ID }))?.data).toMatchObject({
      error: expect.stringMatching(/registration completes/),
    })
  })

  it('records the request, who asked, and queues it for the registry', async () => {
    userClient()
    expect((await unlockTransfers({ domainId: DOMAIN_ID }))?.data).toEqual({ ok: true })
    expect(writes).toEqual([
      { table: 'domains', op: 'update', row: { pending_transfer_lock: false } },
      {
        table: 'domain_events',
        op: 'insert',
        row: {
          domain_id: DOMAIN_ID,
          event_type: 'transfer_lock_requested',
          actor_type: 'user',
          actor_id: 'user-1',
          payload: { to: false },
        },
      },
      queued('set_transfer_lock'),
    ])
  })

  it('says so when the request could not be saved or queued', async () => {
    userClient()
    failing.add('update:domains')
    expect((await unlockTransfers({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: 'That change could not be saved. Please try again.',
    })
    failing = new Set(['enqueue_domain_change'])
    expect((await unlockTransfers({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: 'That change could not be saved. Please try again.',
    })
  })
})

describe('lockTransfers (FR-DS4)', () => {
  it('needs only a signed-in session', async () => {
    userClient({ freshCode: false, domain: { transfer_lock: false } })
    expect((await lockTransfers({ domainId: DOMAIN_ID }))?.data).toEqual({ ok: true })
    expect(writes.at(0)).toEqual({
      table: 'domains',
      op: 'update',
      row: { pending_transfer_lock: true },
    })
  })

  it('does nothing when the registry already holds it and nothing is on its way', async () => {
    userClient()
    expect((await lockTransfers({ domainId: DOMAIN_ID }))?.data).toEqual({ ok: true })
    expect(writes).toEqual([])
  })

  it('asking again re-queues the change already on its way, without a second request', async () => {
    userClient({ domain: { transfer_lock: false, pending_transfer_lock: true } })
    expect((await lockTransfers({ domainId: DOMAIN_ID }))?.data).toEqual({ ok: true })
    expect(writes).toEqual([queued('set_transfer_lock')])
  })

  it('overtakes a change on its way the other way', async () => {
    userClient({ domain: { transfer_lock: true, pending_transfer_lock: false } })
    await lockTransfers({ domainId: DOMAIN_ID })
    expect(writes.at(0)?.row).toEqual({ pending_transfer_lock: true })
  })
})

describe('setPrivacy (FR-DS3)', () => {
  it('is offered only where checkout offers it', async () => {
    userClient({ domain: { tld: 'ng', domain_name: 'getpaid.ng' } })
    expect((await setPrivacy({ domainId: DOMAIN_ID, enabled: true }))?.data).toEqual({
      error: 'Contact privacy is not offered for .ng domains.',
    })
    expect(writes).toEqual([])
  })

  it('records and queues the change', async () => {
    userClient()
    expect((await setPrivacy({ domainId: DOMAIN_ID, enabled: true }))?.data).toEqual({ ok: true })
    expect(writes.map((write) => write.op)).toEqual(['update', 'insert', 'rpc'])
    expect(writes.at(-1)).toEqual(queued('set_privacy'))
  })

  it('does nothing for the value the registry holds, and re-queues one already asked for', async () => {
    userClient()
    await setPrivacy({ domainId: DOMAIN_ID, enabled: false })
    expect(writes).toEqual([])
    userClient({ domain: { pending_privacy: true } })
    await setPrivacy({ domainId: DOMAIN_ID, enabled: true })
    expect(writes).toEqual([queued('set_privacy')])
  })

  it('refuses a demo domain and a stranger’s', async () => {
    userClient({ domain: { source: 'demo' } })
    expect((await setPrivacy({ domainId: DOMAIN_ID, enabled: true }))?.data).toHaveProperty('error')
    userClient({ owns: false })
    expect((await setPrivacy({ domainId: DOMAIN_ID, enabled: true }))?.data).toEqual({
      error: 'That domain is not on your account.',
    })
  })
})

describe('changeRegistrant (FR-DS1, FR-DS2, SEC-2)', () => {
  const change = (registrant = form(), acceptTransferLock = false) =>
    changeRegistrant({ domainId: DOMAIN_ID, registrant, acceptTransferLock })

  it('needs a fresh second factor', async () => {
    userClient({ freshCode: false })
    expect((await change(form({ city: 'Abuja' })))?.serverError).toMatch(/Confirm it's you/)
    expect(writes).toEqual([])
  })

  it('never saves a new name without the customer accepting the 60-day lock', async () => {
    userClient()
    expect((await change(form({ lastName: 'Obi' })))?.data).toEqual({
      error: expect.stringMatching(/60 days/),
      field: 'acceptTransferLock',
    })
    expect(writes).toEqual([])
  })

  it('saves a change of registrant once it is accepted, with no contact details in the log', async () => {
    userClient()
    expect((await change(form({ email: 'ada@okafor.ng' }), true))?.data).toEqual({ ok: true })
    expect(writes[0]).toMatchObject({
      table: 'domains',
      row: { pending_registrant: expect.objectContaining({ email: 'ada@okafor.ng' }) },
    })
    expect(writes[1]).toMatchObject({
      table: 'domain_events',
      row: { event_type: 'contacts_requested', payload: { material: true } },
    })
    expect(JSON.stringify(writes[1])).not.toContain('okafor.ng')
    expect(writes[2]).toEqual(queued('update_contacts'))
  })

  it('saves a new address without asking: it is not a change of registrant', async () => {
    userClient()
    expect(
      (await change(form({ addressLine1: '2 Broad Street', phone: '0803 999 9999' })))?.data,
    ).toEqual({ ok: true })
    expect(writes[0]?.row).toEqual({
      pending_registrant: expect.objectContaining({
        addressLine1: '2 Broad Street',
        phone: '8039999999',
      }),
    })
    expect(writes[1]?.row).toMatchObject({ payload: { material: false } })
  })

  it('does not ask about the lock on a country-code extension', async () => {
    userClient({ domain: { tld: 'ng' } })
    expect((await change(form({ lastName: 'Obi' })))?.data).toEqual({ ok: true })
  })

  it('does nothing when the details are unchanged, and re-queues a change already asked for', async () => {
    userClient()
    expect((await change(form({ firstName: ' ada ' })))?.data).toEqual({ ok: true })
    expect(writes).toEqual([])

    const requested = { ...ADA, city: 'Abuja' }
    userClient({ domain: { pending_registrant: requested } })
    expect((await change(form({ city: 'Abuja' })))?.data).toEqual({ ok: true })
    expect(writes).toEqual([queued('update_contacts')])
  })

  it('reports a phone number the registry would refuse', async () => {
    userClient()
    expect((await change(form({ phone: '0803 123 4567 8901 2345' })))?.data).toEqual({
      error: expect.stringMatching(/phone number/),
    })
  })

  it('checks every field before anything is saved', async () => {
    userClient()
    const result = await change(form({ email: 'not-an-email' }))
    expect(result?.validationErrors).toBeDefined()
    expect(writes).toEqual([])
  })

  it('refuses a demo domain', async () => {
    userClient({ domain: { source: 'demo' } })
    expect((await change(form({ city: 'Abuja' })))?.data).toHaveProperty('error')
    expect(writes).toEqual([])
  })

  it('refuses a stranger’s domain', async () => {
    userClient({ owns: false })
    expect((await change(form({ city: 'Abuja' })))?.data).toEqual({
      error: 'That domain is not on your account.',
    })
  })
})

describe('revealTransferCode (FR-DS5, FR-T5, SEC-2)', () => {
  function gateway(reply: () => Response) {
    const seen: string[] = []
    server.use(
      http.get('http://gateway.test/v1/domains/:name/auth-code', ({ request }) => {
        seen.push(new URL(request.url).pathname + new URL(request.url).search)
        return reply()
      }),
    )
    return seen
  }
  const fromRegistry = () => HttpResponse.json({ ok: true, data: { authCode: CODE } })

  it('needs a fresh second factor, and never asks the registry without one', async () => {
    userClient({ freshCode: false })
    const seen = gateway(fromRegistry)
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.serverError).toMatch(
      /Confirm it's you/,
    )
    expect(seen).toEqual([])
  })

  it('reads the code from the domain’s own registry and records the reveal without it', async () => {
    userClient()
    const seen = gateway(fromRegistry)
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.data).toEqual({
      ok: true,
      code: CODE,
    })
    expect(seen).toEqual(['/v1/domains/getpaid.com/auth-code?side=live'])
    expect(writes).toEqual([
      {
        table: 'domain_events',
        op: 'insert',
        row: {
          domain_id: DOMAIN_ID,
          event_type: 'auth_code_revealed',
          actor_type: 'user',
          actor_id: 'user-1',
          payload: { sandbox: false },
        },
      },
    ])
    expect(JSON.stringify(writes)).not.toContain(CODE)
  })

  it('asks the sandbox for a sandbox domain’s code', async () => {
    userClient({ domain: { test_mode: true } })
    const seen = gateway(fromRegistry)
    await revealTransferCode({ domainId: DOMAIN_ID })
    expect(seen).toEqual(['/v1/domains/getpaid.com/auth-code?side=sandbox'])
  })

  it('does not show a code whose reveal could not be recorded', async () => {
    userClient()
    gateway(fromRegistry)
    failing.add('insert:domain_events')
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: expect.stringMatching(/code was not shown/),
    })
  })

  it('is never held back over billing — only the registry’s state decides (N14)', async () => {
    userClient({ domain: { local_status: 'expired_grace' } })
    gateway(fromRegistry)
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.data).toMatchObject({ ok: true })
  })

  it('says why there is no code for a demo domain, and asks nothing', async () => {
    userClient({ domain: { source: 'demo' } })
    const seen = gateway(fromRegistry)
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: expect.stringMatching(/demo domain/),
    })
    expect(seen).toEqual([])
  })

  it('refuses a stranger’s domain', async () => {
    userClient({ owns: false })
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: 'That domain is not on your account.',
    })
  })

  it('limits how often an account asks', async () => {
    userClient()
    const seen = gateway(fromRegistry)
    withinLimit = false
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: expect.stringMatching(/several times in the last hour/),
    })
    expect(seen).toEqual([])
  })

  it.each([
    ['DOMAIN_NOT_FOUND', 404, /does not list this domain/],
    ['RATE_LIMITED', 429, /asked for several times recently/],
    ['AUTH_CODE_UNAVAILABLE', 502, /gave no transfer code/],
    ['WRONG_REGISTRY', 409, /cannot reach the registry that holds this domain/],
    ['SUPPLIER_UNAVAILABLE', 502, /within five days/],
  ])(
    'explains a %s answer in our words, and still offers the five-day route',
    async (code, status, message) => {
      userClient()
      gateway(() => HttpResponse.json({ ok: false, code, message: 'x' }, { status }))
      const result = await revealTransferCode({ domainId: DOMAIN_ID })
      expect(result?.data).toEqual({ error: expect.stringMatching(message) })
      expect(writes).toEqual([])
    },
  )

  it('offers the email route when the gateway cannot be reached at all', async () => {
    userClient()
    gateway(() => HttpResponse.error())
    expect((await revealTransferCode({ domainId: DOMAIN_ID }))?.data).toEqual({
      error: expect.stringMatching(/hello@mydomainshub\.com/),
    })
  })
})
