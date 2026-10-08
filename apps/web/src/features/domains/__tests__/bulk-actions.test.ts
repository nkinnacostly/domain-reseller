import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { lookupHost } from '../queries/dns'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('../queries/dns', () => ({ lookupHost: vi.fn() }))
// The account-wide rule hook for sensitive changes: stood in for so a refusal can be tested.
const guard = vi.hoisted(() => ({ answer: null as { error: string } | null, calls: 0 }))
vi.mock('../queries/bulk-guard', () => ({
  guardSensitiveBulkChange: async () => {
    guard.calls += 1
    return guard.answer
  },
}))

const {
  changeNameserversInBulk,
  labelDomainsInBulk,
  lockTransfersInBulk,
  setAutoRenewInBulk,
  setPrivacyInBulk,
  unlockTransfersInBulk,
} = await import('../actions/bulk')

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const A = id(1)
const B = id(2)
const LABEL = id(99)
const now = () => Math.floor(Date.now() / 1000)

let owned: { id: string; domain_name: string }[]
let domainsError: { code: string } | null
let domainReads: string[][]
let rpcs: { fn: string; args: Record<string, unknown> }[]
let started: { data: unknown; error: { code?: string } | null }
let allowed: { data: unknown; error: unknown }

/** The signed-in client (RLS), with a second factor as fresh as asked. */
function signedIn({ freshCode = true } = {}) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: {
            currentLevel: 'aal2',
            currentAuthenticationMethods: [
              // Signed in with the password, as elevatedAction requires (security audit).
              { method: 'password', timestamp: now() - 7200 },
              { method: 'totp', timestamp: freshCode ? now() : now() - 3600 },
            ],
          },
        }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        // profiles: no post-reset hold.
        eq: () => ({ single: async () => ({ data: { password_reset_at: null } }) }),
        in: async (_column: string, ids: string[]) => {
          domainReads.push(ids)
          if (table !== 'domains') return { data: [], error: null }
          return {
            data: domainsError ? null : owned.filter((domain) => ids.includes(domain.id)),
            error: domainsError,
          }
        },
      }),
    }),
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  guard.answer = null
  guard.calls = 0
  owned = [
    { id: A, domain_name: 'getpaid.com' },
    { id: B, domain_name: 'naija.ng' },
  ]
  domainsError = null
  domainReads = []
  rpcs = []
  started = { data: 'op-1', error: null }
  allowed = { data: true, error: null }
  signedIn()
  vi.mocked(createServiceClient).mockReturnValue({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args })
      if (fn === 'rate_limit_hit') return allowed
      if (fn === 'start_bulk_change') return started
      throw new Error(`unexpected rpc ${fn}`)
    },
  } as never)
  vi.mocked(lookupHost).mockResolvedValue('resolves')
})

const bulkCalls = () => rpcs.filter((call) => call.fn === 'start_bulk_change')

describe('bulk changes — nothing starts when a check fails', () => {
  it('pauses an account that keeps starting them, and fails closed', async () => {
    for (const answer of [
      { data: false, error: null },
      { data: null, error: { message: 'db down' } },
    ]) {
      allowed = answer
      const result = await setAutoRenewInBulk({ domainIds: [A], enabled: true })
      expect(result?.data).toEqual({ error: expect.stringMatching(/several bulk changes/) })
    }
    expect(bulkCalls()).toEqual([])
  })

  it('refuses an empty choice, and more than 500 domains', async () => {
    expect(
      (await setAutoRenewInBulk({ domainIds: [], enabled: true }))?.validationErrors,
    ).toBeDefined()
    const many = Array.from({ length: 501 }, (_, index) => id(index + 1))
    expect(
      (await setAutoRenewInBulk({ domainIds: many, enabled: true }))?.validationErrors,
    ).toBeDefined()
    expect(rpcs).toEqual([])
  })

  it('says nothing changed when the database refused', async () => {
    started = { data: null, error: { code: '08006' } }
    expect((await setPrivacyInBulk({ domainIds: [A], enabled: true }))?.data).toEqual({
      error: 'That change could not be started. Nothing was changed — please try again.',
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('says a label that is not the account’s is not theirs', async () => {
    started = { data: null, error: { code: '22023' } }
    expect((await labelDomainsInBulk({ domainIds: [A], labelId: LABEL, on: true }))?.data).toEqual({
      error: 'That label is not on your account.',
    })
  })
})

describe('the account guard for sensitive bulk changes', () => {
  const REFUSED = { error: 'Turn on two-factor authentication first.' }

  it('stops nameservers, unlocking and privacy before any lookup or write', async () => {
    guard.answer = REFUSED
    expect(
      (await changeNameserversInBulk({ domainIds: [A], nameservers: 'ns1.a.com\nns2.a.com' }))
        ?.data,
    ).toEqual(REFUSED)
    expect((await unlockTransfersInBulk({ domainIds: [A] }))?.data).toEqual(REFUSED)
    expect((await setPrivacyInBulk({ domainIds: [A], enabled: false }))?.data).toEqual(REFUSED)
    expect(guard.calls).toBe(3)
    expect(lookupHost).not.toHaveBeenCalled()
    expect(domainReads).toEqual([])
    expect(rpcs).toEqual([])
  })

  it('is not asked for locking, auto-renew or labels', async () => {
    guard.answer = REFUSED
    expect((await lockTransfersInBulk({ domainIds: [A] }))?.data).toMatchObject({ ok: true })
    expect((await setAutoRenewInBulk({ domainIds: [A], enabled: true }))?.data).toMatchObject({
      ok: true,
    })
    expect(
      (await labelDomainsInBulk({ domainIds: [A], labelId: LABEL, on: true }))?.data,
    ).toMatchObject({ ok: true })
    expect(guard.calls).toBe(0)
  })
})

describe('bulk changes — one operation, the account from the session', () => {
  it('starts auto-renew for the chosen domains, each once', async () => {
    const result = await setAutoRenewInBulk({ domainIds: [A, B, A], enabled: false })
    expect(result?.data).toEqual({ ok: true, operationId: 'op-1', warnings: [] })
    expect(bulkCalls()).toEqual([
      {
        fn: 'start_bulk_change',
        args: {
          p_user_id: 'user-1',
          p_domain_ids: [A, B],
          p_kind: 'auto_renew',
          p_value: { enabled: false },
        },
      },
    ])
    expect(revalidatePath).toHaveBeenCalledWith('/app/domains', 'layout')
  })

  it('turns contact privacy on or off', async () => {
    await setPrivacyInBulk({ domainIds: [A], enabled: true })
    expect(bulkCalls()[0]?.args).toMatchObject({ p_kind: 'privacy', p_value: { enabled: true } })
  })

  it('puts a label on, or takes it off', async () => {
    await labelDomainsInBulk({ domainIds: [A], labelId: LABEL, on: true })
    await labelDomainsInBulk({ domainIds: [A], labelId: LABEL, on: false })
    expect(bulkCalls().map((call) => [call.args.p_kind, call.args.p_value])).toEqual([
      ['label', { label_id: LABEL }],
      ['unlabel', { label_id: LABEL }],
    ])
  })

  it('locks with a signed-in session', async () => {
    signedIn({ freshCode: false })
    expect((await lockTransfersInBulk({ domainIds: [A] }))?.data).toMatchObject({ ok: true })
    expect(bulkCalls()[0]?.args).toMatchObject({
      p_kind: 'transfer_lock',
      p_value: { locked: true },
    })
  })

  it('unlocks only with a fresh second factor (SEC-2)', async () => {
    signedIn({ freshCode: false })
    const refused = await unlockTransfersInBulk({ domainIds: [A] })
    expect(refused?.serverError).toMatch(/Confirm it's you/)
    expect(bulkCalls()).toEqual([])

    signedIn()
    expect((await unlockTransfersInBulk({ domainIds: [A] }))?.data).toMatchObject({ ok: true })
    expect(bulkCalls()[0]?.args).toMatchObject({ p_value: { locked: false } })
  })
})

describe('changeNameserversInBulk (FR-N2, FR-D4, SEC-2)', () => {
  const input = { domainIds: [A, B], nameservers: 'ns1.vercel-dns.com\nNS2.vercel-dns.com.' }

  it('needs a two-factor code from the last 15 minutes', async () => {
    signedIn({ freshCode: false })
    expect((await changeNameserversInBulk(input))?.serverError).toMatch(/Confirm it's you/)
    expect(lookupHost).not.toHaveBeenCalled()
    expect(bulkCalls()).toEqual([])
  })

  it('checks the set’s syntax before anything else', async () => {
    expect(
      (await changeNameserversInBulk({ domainIds: [A], nameservers: 'ns1.only.com' }))?.data,
    ).toEqual({ error: expect.any(String) })
    expect((await changeNameserversInBulk({ domainIds: [A], nameservers: '   ' }))?.data).toEqual({
      error: 'Enter at least two nameservers.',
    })
    expect(lookupHost).not.toHaveBeenCalled()
  })

  it('stops when the domains cannot be read — fails closed', async () => {
    domainsError = { code: '08006' }
    expect((await changeNameserversInBulk(input))?.data).toEqual({
      error: 'That change could not be started. Nothing was changed — please try again.',
    })
    expect(bulkCalls()).toEqual([])
  })

  it('refuses when none of the domains is the account’s', async () => {
    owned = []
    expect((await changeNameserversInBulk(input))?.data).toEqual({
      error: 'None of those domains are on your account.',
    })
    expect(lookupHost).not.toHaveBeenCalled()
  })

  it('looks each nameserver up once, and blocks a typo for all', async () => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.vercel-dns.com' ? 'nxdomain' : 'resolves',
    )
    const result = await changeNameserversInBulk(input)
    expect(result?.data).toEqual({
      error: 'Some nameservers need fixing before we can use them.',
      details: ["ns2.vercel-dns.com doesn't exist — check the spelling."],
    })
    expect(lookupHost).toHaveBeenCalledTimes(2)
    expect(bulkCalls()).toEqual([])
  })

  it('blocks a nameserver inside one of the domains — it would need glue (FR-N3)', async () => {
    const result = await changeNameserversInBulk({
      domainIds: [A, B],
      nameservers: 'ns1.getpaid.com\nns2.getpaid.com',
    })
    expect(result?.data).toMatchObject({
      details: [
        expect.stringMatching(/^ns1\.getpaid\.com is inside getpaid\.com itself/),
        expect.stringMatching(/^ns2\.getpaid\.com is inside getpaid\.com itself/),
      ],
    })
  })

  it('starts one operation for the account’s own domains, with the checked set', async () => {
    const result = await changeNameserversInBulk({ ...input, presetId: LABEL })
    expect(result?.data).toEqual({ ok: true, operationId: 'op-1', warnings: [] })
    expect(bulkCalls()).toEqual([
      {
        fn: 'start_bulk_change',
        args: {
          p_user_id: 'user-1',
          p_domain_ids: [A, B],
          p_kind: 'nameservers',
          p_value: { nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'], preset_id: LABEL },
        },
      },
    ])
  })

  it('leaves out a domain that is not the account’s', async () => {
    const stranger = id(3)
    await changeNameserversInBulk({ ...input, domainIds: [A, stranger] })
    expect(bulkCalls()[0]?.args.p_domain_ids).toEqual([A])
  })

  it('passes on, once, a nameserver that did not answer just now', async () => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.vercel-dns.com' ? 'no-answer' : 'resolves',
    )
    const result = await changeNameserversInBulk(input)
    expect(result?.data).toEqual({
      ok: true,
      operationId: 'op-1',
      warnings: [expect.stringMatching(/^ns2\.vercel-dns\.com didn't answer just now/)],
    })
  })

  it('reads hundreds of domains in runs, not one long address', async () => {
    const ids = Array.from({ length: 250 }, (_, index) => id(index + 1))
    owned = ids.map((domainId, index) => ({ id: domainId, domain_name: `d${index}.com` }))
    await changeNameserversInBulk({ ...input, domainIds: ids })
    expect(domainReads.map((read) => read.length)).toEqual([100, 100, 50])
    expect(bulkCalls()[0]?.args.p_domain_ids).toHaveLength(250)
  })
})
