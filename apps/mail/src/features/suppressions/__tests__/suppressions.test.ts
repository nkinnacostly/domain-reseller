import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { server } from '../../../../tests/mocks/server'
import { ACCOUNT, fakeSupabase } from '../../accounts/__tests__/fake-supabase'

/**
 * Removing a suppressed address (MAIL-SPEC §7.5, §10; migration 49): SES's
 * tenant list first, with the manager key, each form of the address SES may
 * hold; ours only once SES has let it go; a test account never reaches SES;
 * owners and admins only — and the list's reads.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const { env } = await import('@/lib/env')
const { logger } = await import('@/lib/logger')
const { removeSuppression } = await import('../actions/suppressions')
const { getSuppressions, readSuppressions, searchTerm } = await import('../queries/suppressions')
const { canRemoveSuppressions, REASON, SES_REFUSED, SES_UNAVAILABLE, suppressionRefusal } =
  await import('../lib/words')

const settings = env as {
  MAIL_SES_MANAGER_ACCESS_KEY_ID?: string
  MAIL_SES_MANAGER_SECRET_ACCESS_KEY?: string
}
const SES = 'https://email.eu-west-2.amazonaws.com/v2/email/suppression/addresses/:address'
const ROW = { id: 12, address: 'ada.obi@example.com', ses_address: 'Ada.Obi@Example.com' }
const ACCOUNT_ROW = {
  ses_tenant: 'mdm-0a1b2c3d4e',
  tenant_ready_at: '2026-10-01T00:00:00Z',
  is_e2e: false,
}

function use({
  role = 'owner',
  row = ROW as Record<string, unknown> | null,
  account = ACCOUNT_ROW as Record<string, unknown> | null,
  removed = { ok: true } as unknown,
} = {}) {
  const fake = fakeSupabase({
    role,
    tables: {
      suppressions: { single: { data: row, error: null } },
      accounts: { single: { data: account, error: null } },
    },
    rpc: { remove_suppression: () => ({ data: removed, error: null }) },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

function ses(status = 200, errorType?: string) {
  const asked: { address: string; tenant: string | null; auth: string | null }[] = []
  server.use(
    http.delete(SES, ({ request, params }) => {
      asked.push({
        address: decodeURIComponent(String(params.address)),
        tenant: new URL(request.url).searchParams.get('TenantName'),
        auth: request.headers.get('authorization'),
      })
      return new HttpResponse(status === 200 ? null : '{}', {
        status,
        headers: errorType ? { 'x-amzn-errortype': errorType } : {},
      })
    }),
  )
  return asked
}

beforeEach(() => {
  vi.clearAllMocks()
  settings.MAIL_SES_MANAGER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  settings.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = 'test manager secret, not a real key'
})

const input = { accountId: ACCOUNT, suppressionId: 12 }

describe('removeSuppression', () => {
  it('removes each form SES may hold from the tenant’s list, then ours', async () => {
    const asked = ses(200)
    const fake = use()
    expect((await removeSuppression(input)).data).toEqual({ ok: true })
    expect(asked.map(({ address, tenant }) => ({ address, tenant }))).toEqual([
      { address: 'Ada.Obi@Example.com', tenant: 'mdm-0a1b2c3d4e' },
      { address: 'ada.obi@example.com', tenant: 'mdm-0a1b2c3d4e' },
    ])
    expect(asked[0]?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//)
    expect(fake.rpcCalls).toEqual([{ fn: 'remove_suppression', args: { p_suppression_id: 12 } }])
  })

  it('treats an address SES no longer holds as removed there', async () => {
    ses(404, 'NotFoundException')
    use({ row: { ...ROW, ses_address: null } })
    expect((await removeSuppression(input)).data).toEqual({ ok: true })
  })

  it('keeps the address on our list when SES would not let it go, and logs no address', async () => {
    ses(429, 'TooManyRequestsException')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const fake = use()
    expect((await removeSuppression(input)).data).toEqual({ error: SES_REFUSED })
    expect(fake.rpcCalls).toHaveLength(0)
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@/)
  })

  it('says it is ours to fix when the manager key is missing', async () => {
    settings.MAIL_SES_MANAGER_ACCESS_KEY_ID = undefined
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const fake = use()
    expect((await removeSuppression(input)).data).toEqual({ error: SES_UNAVAILABLE })
    expect(fake.rpcCalls).toHaveLength(0)
    expect(error).toHaveBeenCalled()
  })

  it('never reaches SES for a test account, or one whose tenant is not ready', async () => {
    const asked = ses(200)
    use({ account: { ...ACCOUNT_ROW, is_e2e: true } })
    expect((await removeSuppression(input)).data).toEqual({ ok: true })
    use({ account: { ...ACCOUNT_ROW, tenant_ready_at: null } })
    expect((await removeSuppression(input)).data).toEqual({ ok: true })
    expect(asked).toHaveLength(0)
  })

  it('is for owners and admins only, and words what SQL says', async () => {
    const asked = ses(200)
    const developer = use({ role: 'developer' })
    expect((await removeSuppression(input)).serverError).toMatch(/role/)
    expect(developer.rpcCalls).toHaveLength(0)
    use({ row: null })
    expect((await removeSuppression(input)).data).toEqual({
      error: 'That address is no longer on the list.',
    })
    use({ role: 'admin', removed: { ok: false, code: 'forbidden' } })
    expect((await removeSuppression(input)).data).toEqual({
      error: expect.stringContaining('owner'),
    })
    use({ removed: null })
    expect((await removeSuppression(input)).data).toEqual({
      error: expect.stringContaining('still on'),
    })
    expect(asked.length).toBeGreaterThan(0)
  })

  it('fails loudly when the database cannot be asked', async () => {
    ses(200)
    const fake = fakeSupabase({
      tables: { suppressions: { single: { data: null, error: { code: '08006' } } } },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect((await removeSuppression(input)).serverError).toBeTruthy()
    const broken = use()
    broken.client.rpc.mockResolvedValue({ data: null, error: { code: '08006' } } as never)
    expect((await removeSuppression(input)).serverError).toBeTruthy()
  })
})

describe('the list', () => {
  const row = {
    id: 3,
    address: 'ada@example.com',
    reason: 'complaint',
    source: 'ses',
    created_at: '2026-10-06T08:00:00Z',
  }

  function listing(answer: { data: unknown; error: unknown; count?: number | null }) {
    const calls: { method: string; args: unknown[] }[] = []
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'order', 'range']) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ method, args })
        return chain
      }
    }
    // biome-ignore lint/suspicious/noThenProperty: a PostgREST builder is awaited
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(answer).then(resolve)
    vi.mocked(createClient).mockResolvedValue({ from: () => chain } as never)
    return calls
  }

  it('reads a page of the newest, or one address exactly', async () => {
    const calls = listing({ data: [row, { id: 'x' }], error: null, count: 61 })
    expect(await getSuppressions(ACCOUNT, { page: 2 })).toEqual({
      rows: [
        {
          id: 3,
          address: 'ada@example.com',
          reason: 'complaint',
          source: 'ses',
          createdAt: '2026-10-06T08:00:00Z',
        },
      ],
      total: 61,
    })
    expect(calls).toContainEqual({ method: 'range', args: [50, 99] })
    const search = listing({ data: [row], error: null, count: 1 })
    await getSuppressions(ACCOUNT, { search: 'ada@example.com' })
    expect(search).toContainEqual({ method: 'eq', args: ['address', 'ada@example.com'] })
  })

  it('treats a page past the end as empty, and any other failure as an error', async () => {
    listing({ data: null, error: { code: 'PGRST103' } })
    expect(await getSuppressions(ACCOUNT, { page: 9 })).toEqual({ rows: [], total: 0 })
    listing({ data: null, error: { code: '42501' } })
    expect(await getSuppressions(ACCOUNT)).toBeNull()
    listing({ data: [], error: null, count: null })
    expect(await getSuppressions(ACCOUNT)).toEqual({ rows: [], total: 0 })
  })

  it('reads only rows it understands, and searches by the address as stored', () => {
    expect(readSuppressions('nope')).toEqual([])
    expect(readSuppressions([{ ...row, reason: 'other' }])).toEqual([])
    expect(searchTerm('  Ada@Example.COM ')).toBe('ada@example.com')
    expect(searchTerm('   ')).toBeNull()
    expect(searchTerm(undefined)).toBeNull()
    expect(searchTerm('a'.repeat(400))).toBeNull()
  })

  it('words its reasons, and who may remove', () => {
    expect(REASON.bounce.label).toBe('Bounced')
    expect(canRemoveSuppressions('admin')).toBe(true)
    expect(canRemoveSuppressions('developer')).toBe(false)
    expect(suppressionRefusal({ code: 'unauthorized' })).toMatch(/Sign in/)
    expect(suppressionRefusal({})).toMatch(/still on the list/)
  })
})
