import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { CURRENT_ACCOUNT_COOKIE } from '../lib/current'
import { hashInviteToken } from '../lib/invite-token'
import { RESULT_FALLBACK } from '../lib/results'
import { ACCOUNT, fakeSupabase, INVITE, OTHER_USER } from './fake-supabase'

/**
 * The accounts actions (MAIL-SPEC §7.1, §9, §10; migration 46): what each
 * sends to SQL, what it answers, and that the role check comes first.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
const jar = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn(), get: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: vi.fn(async () => jar),
}))

const { createAccount, switchAccount, updateProfile } = await import('../actions/accounts')
const {
  createInvite,
  revokeInvite,
  acceptInvite,
  changeMemberRole,
  removeMember,
  leaveAccount,
  transferOwnership,
} = await import('../actions/members')

const ok =
  (extra: Record<string, unknown> = {}) =>
  () => ({ data: { ok: true, ...extra }, error: null })
const refuse =
  (code: string, extra: Record<string, unknown> = {}) =>
  () => ({
    data: { ok: false, code, ...extra },
    error: null,
  })
const crash = () => ({ data: null, error: { code: '08006' } })

function use(options: Parameters<typeof fakeSupabase>[0] = {}) {
  const fake = fakeSupabase(options)
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const profile = {
  name: 'Acme',
  website: 'acme.example',
  useCase: 'Order receipts for our shop.',
  expectedMonthlyVolume: '5,000',
}

beforeEach(() => vi.clearAllMocks())

describe('createAccount (§7.1, §7.2)', () => {
  it('needs the transactional-only confirmation before anything reaches SQL', async () => {
    const { rpcCalls } = use()
    const result = await createAccount({ ...profile, transactionalOnly: false as true })
    expect(result?.validationErrors).toBeDefined()
    expect(rpcCalls).toEqual([])
  })

  it('creates it with the cleaned answers, remembers it, and lets the form load the dashboard', async () => {
    const { rpcCalls } = use({ rpc: { create_account: ok({ accountId: ACCOUNT }) } })
    expect((await createAccount({ ...profile, transactionalOnly: true }))?.data).toEqual({
      ok: true,
    })
    expect(rpcCalls).toEqual([
      {
        fn: 'create_account',
        args: {
          p_name: 'Acme',
          p_website: 'https://acme.example',
          p_use_case: 'Order receipts for our shop.',
          p_expected_monthly_volume: 5000,
        },
      },
    ])
    expect(jar.set).toHaveBeenCalledWith(
      CURRENT_ACCOUNT_COOKIE,
      ACCOUNT,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    )
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout')
  })

  it('words the ownership limit with SQL’s number, and a crash as a crash', async () => {
    use({ rpc: { create_account: refuse('limit', { max: 3 }) } })
    expect((await createAccount({ ...profile, transactionalOnly: true }))?.data).toEqual({
      error: expect.stringMatching(/already own 3 open Mail accounts/),
    })
    use({ rpc: { create_account: crash } })
    expect((await createAccount({ ...profile, transactionalOnly: true }))?.serverError).toBe(
      'Something went wrong on our end. Please try again.',
    )
    expect(jar.set).not.toHaveBeenCalled()
  })

  it('refuses a website that is not one, and a volume that is not a number', async () => {
    use()
    const result = await createAccount({
      ...profile,
      website: 'not a site',
      expectedMonthlyVolume: 'lots',
      transactionalOnly: true,
    })
    expect(Object.keys(result?.validationErrors ?? {})).toEqual(
      expect.arrayContaining(['website', 'expectedMonthlyVolume']),
    )
  })
})

describe('switchAccount', () => {
  it('remembers an account the person belongs to', async () => {
    use({ role: 'viewer' })
    expect((await switchAccount({ accountId: ACCOUNT }))?.data).toEqual({ ok: true })
    expect(jar.set).toHaveBeenCalledWith(CURRENT_ACCOUNT_COOKIE, ACCOUNT, expect.any(Object))
  })

  it('never one they do not', async () => {
    use({ role: null })
    expect((await switchAccount({ accountId: ACCOUNT }))?.serverError).toMatch(
      /not one of its members/,
    )
    expect(jar.set).not.toHaveBeenCalled()
  })
})

describe('updateProfile', () => {
  it('is for owners and admins, and says what changed', async () => {
    use({ role: 'developer' })
    expect((await updateProfile({ accountId: ACCOUNT, ...profile }))?.serverError).toMatch(
      /cannot do that/,
    )
    const { rpcCalls } = use({
      role: 'admin',
      rpc: { update_account_profile: ok({ changed: ['website'] }) },
    })
    expect((await updateProfile({ accountId: ACCOUNT, ...profile }))?.data).toEqual({
      ok: true,
      changed: 1,
    })
    expect(rpcCalls[0]?.args).toMatchObject({
      p_account_id: ACCOUNT,
      p_website: 'https://acme.example',
    })
  })

  it('words a refusal, and treats an odd answer as nothing changed', async () => {
    use({ rpc: { update_account_profile: refuse('account_closed') } })
    expect((await updateProfile({ accountId: ACCOUNT, ...profile }))?.data).toEqual({
      error: 'This account is closed, so it cannot be changed.',
    })
    use({ rpc: { update_account_profile: ok() } })
    expect((await updateProfile({ accountId: ACCOUNT, ...profile }))?.data).toEqual({
      ok: true,
      changed: 0,
    })
    use({ rpc: { update_account_profile: crash } })
    expect((await updateProfile({ accountId: ACCOUNT, ...profile }))?.serverError).toBeDefined()
  })
})

describe('createInvite (§9: a hash of the token, the link shown once)', () => {
  it('sends SQL only the hash, and answers the link with the token in it', async () => {
    const { rpcCalls } = use({
      rpc: { create_invite: ok({ inviteId: INVITE, expiresAt: '2026-10-13T10:00:00Z' }) },
    })
    const result = await createInvite({
      accountId: ACCOUNT,
      email: ' Bola@Example.com ',
      role: 'developer',
    })
    const data = result?.data as { link: string; expiresAt: string }
    const token = new URL(data.link).searchParams.get('token') ?? ''
    expect(data.link).toMatch(/^http:\/\/localhost:3001\/invite\?token=[A-Za-z0-9_-]{43}$/)
    expect(data.expiresAt).toBe('2026-10-13T10:00:00Z')
    expect(rpcCalls).toEqual([
      {
        fn: 'create_invite',
        args: {
          p_account_id: ACCOUNT,
          p_email: 'bola@example.com',
          p_role: 'developer',
          p_token_hash: hashInviteToken(token),
        },
      },
    ])
    expect(JSON.stringify(rpcCalls)).not.toContain(token)
  })

  it('is refused to developers before SQL, and words SQL’s refusals', async () => {
    const { rpcCalls } = use({ role: 'developer' })
    expect(
      (await createInvite({ accountId: ACCOUNT, email: 'b@example.com', role: 'viewer' }))
        ?.serverError,
    ).toMatch(/cannot do that/)
    expect(rpcCalls).toEqual([])
    use({ rpc: { create_invite: refuse('member_limit', { max: 1 }) } })
    expect(
      (await createInvite({ accountId: ACCOUNT, email: 'b@example.com', role: 'viewer' }))?.data,
    ).toEqual({ error: expect.stringMatching(/1 member seat/), code: 'member_limit' })
    use({ rpc: { create_invite: crash } })
    expect(
      (await createInvite({ accountId: ACCOUNT, email: 'b@example.com', role: 'viewer' }))
        ?.serverError,
    ).toBeDefined()
  })

  it('never invites an owner', async () => {
    use()
    expect(
      (await createInvite({ accountId: ACCOUNT, email: 'b@example.com', role: 'owner' as never }))
        ?.validationErrors,
    ).toBeDefined()
  })
})

describe('revokeInvite', () => {
  it('revokes by id, and words a refusal', async () => {
    const { rpcCalls } = use({ rpc: { revoke_invite: ok() } })
    expect((await revokeInvite({ accountId: ACCOUNT, inviteId: INVITE }))?.data).toEqual({
      ok: true,
    })
    expect(rpcCalls[0]).toEqual({ fn: 'revoke_invite', args: { p_invite_id: INVITE } })
    use({ rpc: { revoke_invite: refuse('accepted') } })
    expect((await revokeInvite({ accountId: ACCOUNT, inviteId: INVITE }))?.data).toEqual({
      error: 'That invite has already been used.',
      code: 'accepted',
    })
    use({ rpc: { revoke_invite: crash } })
    expect(
      (await revokeInvite({ accountId: ACCOUNT, inviteId: INVITE }))?.serverError,
    ).toBeDefined()
  })
})

describe('acceptInvite', () => {
  const token = 'a'.repeat(43)

  it('looks up only something that could be a token', async () => {
    const { rpcCalls } = use()
    expect((await acceptInvite({ token: 'nope' }))?.data).toEqual({
      error: expect.stringMatching(/not found/),
    })
    expect(rpcCalls).toEqual([])
  })

  it('joins by the token’s hash, and remembers the account joined', async () => {
    const { rpcCalls } = use({ rpc: { accept_invite: ok({ accountId: ACCOUNT, role: 'viewer' }) } })
    expect((await acceptInvite({ token }))?.data).toEqual({ ok: true })
    expect(rpcCalls[0]).toEqual({
      fn: 'accept_invite',
      args: { p_token_hash: hashInviteToken(token) },
    })
    expect(jar.set).toHaveBeenCalledWith(CURRENT_ACCOUNT_COOKIE, ACCOUNT, expect.any(Object))
  })

  it('says why it could not join', async () => {
    use({ rpc: { accept_invite: refuse('wrong_email') } })
    expect((await acceptInvite({ token }))?.data).toEqual({
      error: expect.stringMatching(/different email address/),
      code: 'wrong_email',
    })
    use({ rpc: { accept_invite: ok() } })
    expect((await acceptInvite({ token }))?.data).toEqual({ error: RESULT_FALLBACK })
    use({ rpc: { accept_invite: crash } })
    expect((await acceptInvite({ token }))?.serverError).toBeDefined()
  })
})

describe('members: roles, removal, leaving', () => {
  it('changes a role, and words a refusal', async () => {
    const { rpcCalls } = use({ rpc: { change_member_role: ok() } })
    expect(
      (await changeMemberRole({ accountId: ACCOUNT, userId: OTHER_USER, role: 'viewer' }))?.data,
    ).toEqual({ ok: true })
    expect(rpcCalls[0]?.args).toEqual({
      p_account_id: ACCOUNT,
      p_user_id: OTHER_USER,
      p_role: 'viewer',
    })
    use({ rpc: { change_member_role: refuse('owner_role') } })
    expect(
      (await changeMemberRole({ accountId: ACCOUNT, userId: OTHER_USER, role: 'viewer' }))?.data,
    ).toEqual({ error: expect.stringMatching(/hands the account over/), code: 'owner_role' })
    use({ rpc: { change_member_role: crash } })
    expect(
      (await changeMemberRole({ accountId: ACCOUNT, userId: OTHER_USER, role: 'viewer' }))
        ?.serverError,
    ).toBeDefined()
  })

  it('removes a member, and words a refusal', async () => {
    use({ rpc: { remove_member: ok() } })
    expect((await removeMember({ accountId: ACCOUNT, userId: OTHER_USER }))?.data).toEqual({
      ok: true,
    })
    use({ rpc: { remove_member: refuse('use_leave') } })
    expect((await removeMember({ accountId: ACCOUNT, userId: OTHER_USER }))?.data).toEqual({
      error: expect.stringMatching(/Leave this account/),
      code: 'use_leave',
    })
    use({ rpc: { remove_member: crash } })
    expect(
      (await removeMember({ accountId: ACCOUNT, userId: OTHER_USER }))?.serverError,
    ).toBeDefined()
  })

  it('leaves, forgets the account, and words the owner’s refusal', async () => {
    use({ role: 'viewer', rpc: { leave_account: ok() } })
    expect((await leaveAccount({ accountId: ACCOUNT }))?.data).toEqual({ ok: true })
    expect(jar.delete).toHaveBeenCalledWith(CURRENT_ACCOUNT_COOKIE)
    use({ rpc: { leave_account: refuse('owner_must_transfer') } })
    expect((await leaveAccount({ accountId: ACCOUNT }))?.data).toEqual({
      error: expect.stringMatching(/cannot leave/),
      code: 'owner_must_transfer',
    })
    use({ rpc: { leave_account: crash } })
    expect((await leaveAccount({ accountId: ACCOUNT }))?.serverError).toBeDefined()
  })
})

describe('transferOwnership', () => {
  const name = (value: string) => ({ accounts: { single: { data: { name: value }, error: null } } })
  const input = { accountId: ACCOUNT, userId: OTHER_USER, confirmName: 'Acme Ltd' }

  it('is the owner’s alone', async () => {
    use({ role: 'admin' })
    expect((await transferOwnership(input))?.serverError).toMatch(/cannot do that/)
  })

  it('needs the account’s name typed exactly', async () => {
    const { rpcCalls } = use({ tables: name('Acme Limited') })
    expect((await transferOwnership(input))?.data).toEqual({
      error: expect.stringMatching(/not the account’s name/),
    })
    expect(rpcCalls).toEqual([])
  })

  it('hands it over, and words SQL’s refusals', async () => {
    const { rpcCalls } = use({ tables: name('Acme Ltd'), rpc: { transfer_ownership: ok() } })
    expect((await transferOwnership(input))?.data).toEqual({ ok: true })
    expect(rpcCalls[0]).toEqual({
      fn: 'transfer_ownership',
      args: { p_account_id: ACCOUNT, p_user_id: OTHER_USER },
    })
    use({ tables: name('Acme Ltd'), rpc: { transfer_ownership: refuse('needs_aal2') } })
    expect((await transferOwnership(input))?.data).toEqual({
      error: expect.stringMatching(/two-factor on/),
      code: 'needs_aal2',
    })
    use({ tables: name('Acme Ltd'), rpc: { transfer_ownership: crash } })
    expect((await transferOwnership(input))?.serverError).toBeDefined()
    use({ tables: { accounts: { single: { data: null, error: { code: 'x' } } } } })
    expect((await transferOwnership(input))?.serverError).toBeDefined()
  })
})
