import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { hashInviteToken } from '../lib/invite-token'
import { ACCOUNT, fakeSupabase } from './fake-supabase'

/** The accounts reads, as the person (RLS): what each asks, and its four outcomes. */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))
const jar = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => jar) }))
// React's request cache would keep one test's answer for the next.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}))

const { getCurrentAccount, getMemberships } = await import('../queries/accounts')
const { getOverview, getPlan, getUsage } = await import('../queries/overview')
const { getMembers, getPendingInvites, previewInvite } = await import('../queries/members')
const { getAuditLog } = await import('../queries/audit')

function use(options: Parameters<typeof fakeSupabase>[0] = {}) {
  const fake = fakeSupabase(options)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const accountRow = (id: string, state = 'sandbox') => ({
  id,
  name: `Account ${id}`,
  state,
  ses_status: 'pending',
  plan_code: 'free',
  website: null,
  use_case: null,
  expected_monthly_volume: null,
  created_at: '2026-10-06T10:00:00Z',
})

beforeEach(() => {
  vi.clearAllMocks()
  jar.get.mockReturnValue(undefined)
})

describe('the person’s accounts', () => {
  it('is nobody’s when signed out', async () => {
    use({ user: null })
    expect(await getMemberships()).toBeNull()
    expect(await getCurrentAccount()).toBeNull()
  })

  it('reads their memberships, oldest first, and shows the remembered one', async () => {
    const { calls } = use({
      tables: {
        members: {
          rows: {
            data: [
              { role: 'owner', accounts: accountRow('a') },
              { role: 'viewer', accounts: accountRow('b') },
            ],
            error: null,
          },
        },
      },
    })
    jar.get.mockReturnValue({ value: 'b' })
    const current = await getCurrentAccount()
    expect(current?.memberships.map((m) => m.account.id)).toEqual(['a', 'b'])
    expect(current?.current).toMatchObject({ role: 'viewer', account: { id: 'b' } })
    expect(calls).toContainEqual({ table: 'members', method: 'eq', args: ['user_id', 'user-1'] })
    expect(calls).toContainEqual({
      table: 'members',
      method: 'order',
      args: ['created_at', { ascending: true }],
    })
  })

  it('is null with no account (onboarding), and throws when it cannot be read', async () => {
    use({ tables: { members: { rows: { data: [], error: null } } } })
    expect(await getCurrentAccount()).toBeNull()
    use({ tables: { members: { rows: { data: null, error: { code: '42501' } } } } })
    await expect(getMemberships()).rejects.toThrow('memberships could not be read: 42501')
  })
})

describe('the Overview’s figures', () => {
  const usage = {
    ok: true,
    day: '2026-10-06',
    monthStart: '2026-10-01',
    planCode: 'free',
    caps: { daily: 100, monthly: 3000 },
    today: { queued: 1, sent: 1, delivered: 1, bounced: 0, complained: 0, failed: 0 },
    month: { queued: 4, sent: 4, delivered: 3, bounced: 1, complained: 0, failed: 0 },
  }

  it('reads usage, the plan, verified domains and live keys', async () => {
    const { rpcCalls, calls } = use({
      rpc: { account_usage: () => ({ data: usage, error: null }) },
      tables: {
        plans: { single: { data: { code: 'free', name: 'Free', max_members: 1 }, error: null } },
        domains: { rows: { data: null, error: null, count: 1 } },
        api_keys: { rows: { data: null, error: null, count: 2 } },
      },
    })
    const overview = await getOverview(ACCOUNT, 'owner', 'free')
    expect(overview).toMatchObject({
      plan: { code: 'free', name: 'Free', maxMembers: 1 },
      verifiedDomains: 1,
      activeKeys: 2,
      usage: { caps: { daily: 100, monthly: 3000 } },
    })
    expect(rpcCalls).toEqual([{ fn: 'account_usage', args: { p_account_id: ACCOUNT } }])
    expect(calls).toContainEqual({ table: 'domains', method: 'eq', args: ['status', 'verified'] })
    expect(calls).toContainEqual({ table: 'api_keys', method: 'is', args: ['revoked_at', null] })
  })

  it('never asks a viewer’s keys, and says “unknown” for what could not be read', async () => {
    const { calls } = use({
      rpc: { account_usage: () => ({ data: null, error: { code: '42501' } }) },
      tables: {
        plans: { single: { data: null, error: { code: 'x' } } },
        domains: { rows: { data: null, error: { code: 'x' } } },
      },
    })
    expect(await getOverview(ACCOUNT, 'viewer', 'free')).toEqual({
      usage: null,
      plan: null,
      verifiedDomains: null,
      activeKeys: null,
    })
    expect(calls.some((call) => call.table === 'api_keys')).toBe(false)
  })

  it('counts nothing as zero, not as unknown', async () => {
    use({
      rpc: { account_usage: () => ({ data: usage, error: null }) },
      tables: {
        domains: { rows: { data: null, error: null } },
        api_keys: { rows: { data: null, error: null } },
        plans: { single: { data: null, error: null } },
      },
    })
    const overview = await getOverview(ACCOUNT, 'developer', 'free')
    expect([overview.verifiedDomains, overview.activeKeys]).toEqual([0, 0])
    expect(await getUsage(ACCOUNT)).not.toBeNull()
    expect(await getPlan('free')).toBeNull()
  })
})

describe('members and invites', () => {
  it('lists members from account_members, dropping rows it cannot read', async () => {
    use({
      rpc: {
        account_members: () => ({
          data: {
            ok: true,
            members: [
              {
                userId: 'u-1',
                email: 'ada@example.com',
                name: 'Ada',
                role: 'owner',
                joinedAt: 't',
              },
              { userId: 'u-2', email: null, name: null, role: 'boss', joinedAt: 't' },
              { userId: 'u-3', role: 'viewer' },
            ],
          },
          error: null,
        }),
      },
    })
    expect(await getMembers(ACCOUNT)).toEqual([
      { userId: 'u-1', email: 'ada@example.com', name: 'Ada', role: 'owner', joinedAt: 't' },
      { userId: 'u-3', email: null, name: null, role: 'viewer', joinedAt: '' },
    ])
  })

  it('is null when the members cannot be read', async () => {
    use({
      rpc: { account_members: () => ({ data: { ok: false, code: 'not_found' }, error: null }) },
    })
    expect(await getMembers(ACCOUNT)).toBeNull()
  })

  it('lists invites still waiting: not accepted, not revoked, not expired', async () => {
    const { calls } = use({
      tables: {
        invites: {
          rows: {
            data: [
              {
                id: 'i-1',
                email: 'b@example.com',
                role: 'developer',
                created_at: 'c',
                expires_at: 'e',
              },
              {
                id: 'i-2',
                email: 'c@example.com',
                role: 'owner',
                created_at: 'c',
                expires_at: 'e',
              },
            ],
            error: null,
          },
        },
      },
    })
    expect(await getPendingInvites(ACCOUNT)).toEqual([
      { id: 'i-1', email: 'b@example.com', role: 'developer', createdAt: 'c', expiresAt: 'e' },
    ])
    expect(calls).toContainEqual({ table: 'invites', method: 'is', args: ['accepted_at', null] })
    expect(calls).toContainEqual({ table: 'invites', method: 'is', args: ['revoked_at', null] })
    expect(calls.find((call) => call.method === 'gt')?.args[0]).toBe('expires_at')
    use({ tables: { invites: { rows: { data: null, error: { code: 'x' } } } } })
    expect(await getPendingInvites(ACCOUNT)).toBeNull()
  })

  it('previews an invite by its token’s hash, never the token', async () => {
    const token = 'b'.repeat(43)
    const { rpcCalls } = use({
      rpc: {
        invite_preview: () => ({
          data: {
            ok: true,
            accountId: ACCOUNT,
            accountName: 'Acme',
            role: 'viewer',
            expiresAt: 'e',
          },
          error: null,
        }),
      },
    })
    expect(await previewInvite(token)).toEqual({
      ok: true,
      accountId: ACCOUNT,
      accountName: 'Acme',
      role: 'viewer',
      expiresAt: 'e',
    })
    expect(rpcCalls).toEqual([
      { fn: 'invite_preview', args: { p_token_hash: hashInviteToken(token) } },
    ])
  })

  it('answers a refusal’s code, and refuses what cannot be a token without asking', async () => {
    const { rpcCalls } = use({
      rpc: { invite_preview: () => ({ data: { ok: false, code: 'expired' }, error: null }) },
    })
    expect(await previewInvite('c'.repeat(43))).toEqual({ ok: false, code: 'expired' })
    expect(await previewInvite('')).toEqual({ ok: false, code: 'not_found' })
    expect(rpcCalls).toHaveLength(1)
    use({ rpc: { invite_preview: () => ({ data: { ok: true, role: 'owner' }, error: null }) } })
    expect(await previewInvite('c'.repeat(43))).toEqual({ ok: false, code: 'not_found' })
    use({ rpc: { invite_preview: () => ({ data: null, error: { code: 'x' } }) } })
    await expect(previewInvite('c'.repeat(43))).rejects.toThrow('invite_preview failed: x')
  })
})

describe('the account log', () => {
  it('reads the newest hundred, and is null when it cannot be read', async () => {
    const { calls } = use({
      tables: {
        account_audit_log: {
          rows: {
            data: [
              {
                id: 1,
                at: 't',
                actor: 'user',
                actor_user_id: 'u',
                action: 'account.created',
                target: null,
                detail: {},
              },
            ],
            error: null,
          },
        },
      },
    })
    expect((await getAuditLog(ACCOUNT))?.map((row) => row.action)).toEqual(['account.created'])
    expect(calls).toContainEqual({ table: 'account_audit_log', method: 'limit', args: [100] })
    use({ tables: { account_audit_log: { rows: { data: null, error: { code: 'x' } } } } })
    expect(await getAuditLog(ACCOUNT)).toBeNull()
  })
})
