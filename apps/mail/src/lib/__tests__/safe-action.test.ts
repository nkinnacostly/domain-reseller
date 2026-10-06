import { AppError } from '@dr/shared/errors'
import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import {
  accountAction,
  actionClient,
  authAction,
  isMemberRole,
  NOT_A_MEMBER,
  ROLE_TOO_LOW,
  SERVER_CRASH_WORDS,
} from '../safe-action'

vi.mock('next/headers', () => ({ headers: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'

/** A session as the server client sees it: who, and their row in mail.members. */
function session(
  user: { id: string } | null,
  member: { data: unknown; error: unknown } = { data: null, error: null },
) {
  const eqs: unknown[][] = []
  const query = {
    select: () => query,
    eq: (...args: unknown[]) => {
      eqs.push(args)
      return query
    },
    maybeSingle: async () => member,
  }
  const from = vi.fn(() => query)
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
    from,
  } as never)
  return { from, eqs }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
})

describe('actionClient', () => {
  const requestId = actionClient.action(async ({ ctx }) => ctx.requestId)

  it('carries the request’s own id when it is a uuid, and makes one up otherwise', async () => {
    const id = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-request-id': id }) as never)
    expect(await requestId()).toEqual({ data: id })
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-request-id': 'not-a-uuid' }) as never)
    expect((await requestId()).data).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('shows an AppError’s words, and nothing of an unexpected error', async () => {
    expect(
      await actionClient.action(async () => {
        throw new AppError('CONFLICT', 'That key name is taken.')
      })(),
    ).toEqual({ serverError: 'That key name is taken.' })
    const crash = await actionClient.action(async () => {
      throw new Error('relation "mail.emails" does not exist')
    })()
    expect(crash).toEqual({ serverError: SERVER_CRASH_WORDS })
  })
})

describe('authAction', () => {
  it('needs a signed-in person', async () => {
    session(null)
    expect(await authAction.action(async () => 'ok')()).toEqual({
      serverError: 'Please sign in to continue.',
    })
    session({ id: 'u-1' })
    expect(await authAction.action(async ({ ctx }) => ctx.user.id)()).toEqual({ data: 'u-1' })
  })
})

describe('accountAction', () => {
  const schema = z.object({ accountId: z.string(), name: z.string() })
  const rename = accountAction(schema, ['owner', 'admin']).action(async ({ parsedInput, ctx }) => ({
    name: parsedInput.name,
    account: ctx.account,
  }))

  it('resolves the caller’s role in the account the input names, through RLS', async () => {
    const { from, eqs } = session({ id: 'u-1' }, { data: { role: 'admin' }, error: null })
    expect(await rename({ accountId: ACCOUNT, name: 'Acme' })).toEqual({
      data: { name: 'Acme', account: { id: ACCOUNT, role: 'admin' } },
    })
    expect(from).toHaveBeenCalledWith('members')
    expect(eqs).toEqual([
      ['account_id', ACCOUNT],
      ['user_id', 'u-1'],
    ])
  })

  it('refuses a role the action does not allow', async () => {
    session({ id: 'u-1' }, { data: { role: 'viewer' }, error: null })
    expect(await rename({ accountId: ACCOUNT, name: 'Acme' })).toEqual({
      serverError: ROLE_TOO_LOW,
    })
  })

  it('says the same thing for someone else’s account and one that does not exist', async () => {
    session({ id: 'u-1' })
    expect(await rename({ accountId: ACCOUNT, name: 'Acme' })).toEqual({
      serverError: NOT_A_MEMBER,
    })
    session({ id: 'u-1' }, { data: { role: 'superuser' }, error: null })
    expect(await rename({ accountId: ACCOUNT, name: 'Acme' })).toEqual({
      serverError: NOT_A_MEMBER,
    })
    const { from } = session({ id: 'u-1' })
    expect(await rename({ accountId: '../other', name: 'Acme' })).toEqual({
      serverError: NOT_A_MEMBER,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('treats a failed read as a failure, never as a role', async () => {
    session({ id: 'u-1' }, { data: null, error: { code: '42P01' } })
    expect(await rename({ accountId: ACCOUNT, name: 'Acme' })).toEqual({
      serverError: SERVER_CRASH_WORDS,
    })
  })

  it('validates the input before asking anything, and allows every role by default', async () => {
    const { from } = session({ id: 'u-1' }, { data: { role: 'viewer' }, error: null })
    const invalid = await rename({ accountId: ACCOUNT } as never)
    expect(invalid.validationErrors).toBeDefined()
    expect(from).not.toHaveBeenCalled()
    const read = accountAction(z.object({ accountId: z.string() })).action(
      async ({ ctx }) => ctx.account.role,
    )
    expect(await read({ accountId: ACCOUNT })).toEqual({ data: 'viewer' })
    expect(isMemberRole('owner')).toBe(true)
    expect(isMemberRole(3)).toBe(false)
  })
})
