import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const { changeContactRole } = await import('../actions/settings')

const DOMAIN_ID = '00000000-0000-4000-8000-000000000001'
const PROFILE_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
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
const BOLA = { ...ADA, firstName: 'Bola', lastName: 'Ade', email: 'accounts@example.com' }
const CHI = { ...ADA, firstName: 'Chi', lastName: 'Obi', email: 'tech@example.com' }
/** New details as the form sends them: every field a string. */
const details = (contact: typeof ADA) => ({
  kind: 'new' as const,
  contact: { company: '', addressLine2: '', ...contact },
})

type Row = Record<string, unknown>
const DOMAIN: Row = {
  id: DOMAIN_ID,
  domain_name: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  test_mode: true,
  local_status: 'active',
  registrant: ADA,
  contacts: null,
  pending_registrant: null,
  pending_contacts: null,
}
const PROFILE_ROW = {
  id: PROFILE_ID,
  label: 'Accounts',
  is_default: false,
  first_name: 'Bola',
  last_name: 'Ade',
  company: null,
  email: 'accounts@example.com',
  phone: '8031234567',
  phone_country_code: '234',
  address_line1: '1 Marina',
  address_line2: null,
  city: 'Lagos',
  state: 'Lagos',
  zip_code: '100001',
  country: 'NG',
}

/** The user's own client (RLS): their domain, their saved contacts, their second factor. */
function userClient({
  owns = true,
  freshCode = true,
  domain = {} as Row,
  profile = PROFILE_ROW as Row | null,
} = {}) {
  const row = owns ? { ...DOMAIN, ...domain } : null
  const read = (table: string) =>
    table === 'domains' ? row : table === 'contact_profiles' ? profile : null
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: {
            currentLevel: 'aal2',
            currentAuthenticationMethods: [
              { method: 'password', timestamp: Math.floor(Date.now() / 1000) - 7200 },
              { method: 'totp', timestamp: freshCode ? now() : now() - 3600 },
            ],
          },
        }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: read(table), error: null }),
          single: async () => ({ data: { password_reset_at: null } }),
        }),
      }),
    }),
  } as never)
}

let writes: { table: string; op: string; row: unknown }[]
let failing: Set<string>

beforeEach(() => {
  vi.clearAllMocks()
  writes = []
  failing = new Set()
  vi.mocked(createServiceClient).mockReturnValue({
    rpc: async (fn: string, args: unknown) => {
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
        return { error: null }
      },
    }),
  } as never)
})

const change = (role: string, choice: unknown) =>
  changeContactRole({ domainId: DOMAIN_ID, role, choice } as never)
const queued = {
  table: 'enqueue_domain_change',
  op: 'rpc',
  row: { p_domain_id: DOMAIN_ID, p_kind: 'update_contacts' },
}
const pendingWrite = () => writes.find((write) => write.table === 'domains')?.row

describe('changeContactRole — nothing is saved when a check fails (FR-DS1, SEC-2)', () => {
  it('needs a two-factor code from the last 15 minutes', async () => {
    userClient({ freshCode: false })
    expect((await change('billing', details(BOLA)))?.serverError).toMatch(/Confirm it's you/)
    expect(writes).toEqual([])
  })

  it('refuses a domain that is not yours, and a demo domain', async () => {
    userClient({ owns: false })
    expect((await change('billing', details(BOLA)))?.data).toEqual({
      error: 'That domain is not on your account.',
    })
    userClient({ domain: { source: 'demo' } })
    expect((await change('billing', details(BOLA)))?.data).toMatchObject({
      error: expect.stringMatching(/not registered anywhere/),
    })
    expect(writes).toEqual([])
  })

  it('refuses a role it does not know, and details that fail the registrant’s checks', async () => {
    userClient()
    expect((await change('owner', details(BOLA)))?.validationErrors).toBeDefined()
    const result = await change('billing', details({ ...BOLA, email: 'nope' }))
    expect(result?.validationErrors).toMatchObject({
      choice: { contact: { email: { _errors: ['Enter a valid email address'] } } },
    })
    expect(writes).toEqual([])
  })

  it('refuses a saved contact that is not the account’s own (RLS reads nothing)', async () => {
    userClient({ profile: null })
    expect((await change('billing', { kind: 'profile', profileId: PROFILE_ID }))?.data).toEqual({
      error:
        'That saved contact is no longer on your account. Choose another, or enter new details.',
    })
    expect(writes).toEqual([])
  })

  it('says so when the request could not be saved or queued', async () => {
    userClient()
    failing.add('update:domains')
    expect((await change('billing', details(BOLA)))?.data).toEqual({
      error: 'That change could not be saved. Please try again.',
    })
    failing = new Set(['enqueue_domain_change'])
    expect((await change('billing', details(BOLA)))?.data).toEqual({
      error: 'That change could not be saved. Please try again.',
    })
  })
})

describe('changeContactRole — what is sent (migration 29)', () => {
  it('records the role as a pending change, logs the role only (N13), and queues it', async () => {
    userClient()
    expect((await change('billing', details(BOLA)))?.data).toEqual({ ok: true })
    expect(writes).toEqual([
      {
        table: 'domains',
        op: 'update',
        row: { pending_contacts: { billing: expect.objectContaining({ firstName: 'Bola' }) } },
      },
      {
        table: 'domain_events',
        op: 'insert',
        row: {
          domain_id: DOMAIN_ID,
          event_type: 'contacts_requested',
          actor_type: 'user',
          actor_id: 'user-1',
          payload: { roles: ['billing'] },
        },
      },
      queued,
    ])
    expect(JSON.stringify(writes[1])).not.toContain('Bola')
  })

  it('takes a saved contact as the database holds it', async () => {
    userClient()
    expect((await change('technical', { kind: 'profile', profileId: PROFILE_ID }))?.data).toEqual({
      ok: true,
    })
    expect(pendingWrite()).toEqual({
      pending_contacts: { technical: expect.objectContaining({ email: 'accounts@example.com' }) },
    })
  })

  it('keeps the other roles the registry holds', async () => {
    userClient({ domain: { contacts: { technical: CHI } } })
    await change('billing', details(BOLA))
    expect(pendingWrite()).toEqual({
      pending_contacts: { technical: CHI, billing: expect.objectContaining({ firstName: 'Bola' }) },
    })
  })

  it('builds on a change already on its way, not on what the registry holds', async () => {
    userClient({
      domain: { contacts: { technical: CHI }, pending_contacts: { administrative: BOLA } },
    })
    await change('billing', details(BOLA))
    expect(pendingWrite()).toEqual({
      pending_contacts: {
        administrative: BOLA,
        billing: expect.objectContaining({ firstName: 'Bola' }),
      },
    })
  })

  it('hands a role back to the registrant; the last one back is an empty set', async () => {
    userClient({ domain: { contacts: { billing: BOLA } } })
    expect((await change('billing', { kind: 'registrant' }))?.data).toEqual({ ok: true })
    expect(pendingWrite()).toEqual({ pending_contacts: {} })
  })

  it('treats the registrant’s own details as the registrant’s role', async () => {
    userClient({ domain: { contacts: { billing: BOLA } } })
    await change('billing', details({ ...ADA, email: 'ADA@example.com' }))
    expect(pendingWrite()).toEqual({ pending_contacts: {} })
  })

  it('compares with the registrant on its way, if one is', async () => {
    userClient({ domain: { pending_registrant: BOLA } })
    await change('billing', details(ADA))
    expect(pendingWrite()).toEqual({
      pending_contacts: { billing: expect.objectContaining({ firstName: 'Ada' }) },
    })
  })

  it('does nothing for what the registry already holds, and nothing is on its way', async () => {
    userClient({ domain: { contacts: { billing: BOLA } } })
    expect((await change('billing', details({ ...BOLA, city: ' lagos ' })))?.data).toEqual({
      ok: true,
    })
    userClient()
    expect((await change('technical', { kind: 'registrant' }))?.data).toEqual({ ok: true })
    expect(writes).toEqual([])
  })

  it('asking again for the change on its way re-queues it, without a second request', async () => {
    userClient({ domain: { pending_contacts: { billing: BOLA } } })
    expect((await change('billing', details(BOLA)))?.data).toEqual({ ok: true })
    expect(writes).toEqual([queued])
  })

  it('never asks about the 60-day lock: that is the registrant’s alone (FR-DS2)', async () => {
    userClient()
    const result = await change('administrative', details({ ...BOLA, company: 'Paidly' } as never))
    expect(result?.data).toEqual({ ok: true })
  })
})
