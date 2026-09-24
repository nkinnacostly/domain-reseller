import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { describeLastSeen, formatSessionDate } from '../lib/sessions'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const { getSessions } = await import('../queries/sessions')
const { revokeSession, signOutOtherSessions } = await import('../actions/sessions')
const { revalidatePath } = await import('next/cache')
const { logger } = await import('@/lib/logger')

const OTHER = '00000000-0000-4000-8000-000000000002'

/** A session Supabase client shaped like the calls the sessions code makes. */
function client({
  rows = [] as unknown[] | null,
  rpcError = null as { message: string } | null,
  revoked = true,
  aal = { currentLevel: 'aal1', nextLevel: 'aal1' },
  signOutError = null as { code?: string } | null,
  user = { id: 'user-1' } as { id: string } | null,
} = {}) {
  const rpc = vi.fn(async (name: string) =>
    name === 'my_sessions'
      ? { data: rows, error: rpcError }
      : { data: rpcError ? null : revoked, error: rpcError },
  )
  const fake = {
    rpc,
    auth: {
      getUser: vi.fn(async () => ({ data: { user } })),
      signOut: vi.fn(async () => ({ error: signOutError })),
      mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: aal })) },
    },
  }
  vi.mocked(createClient).mockResolvedValue(fake as never)
  return fake
}

beforeEach(() => vi.clearAllMocks())

describe('describeLastSeen', () => {
  const now = new Date('2026-09-24T12:00:00Z')

  it('is never more precise than a renewal allows', () => {
    expect(describeLastSeen('2026-09-24T11:59:00Z', now)).toBe('in the last hour')
    expect(describeLastSeen('2026-09-24T11:00:01Z', now)).toBe('in the last hour')
  })

  it('counts hours, then days, then gives the date', () => {
    expect(describeLastSeen('2026-09-24T11:00:00Z', now)).toBe('1 hour ago')
    expect(describeLastSeen('2026-09-24T02:00:00Z', now)).toBe('10 hours ago')
    expect(describeLastSeen('2026-09-23T11:00:00Z', now)).toBe('1 day ago')
    expect(describeLastSeen('2026-09-19T12:00:00Z', now)).toBe('5 days ago')
    expect(describeLastSeen('2026-09-10T12:00:00Z', now)).toBe('on 10 Sept 2026')
  })

  it('writes dates in Lagos time', () => {
    // 23:30 UTC is already the next day in Lagos.
    expect(formatSessionDate('2026-09-22T23:30:00Z')).toBe('23 Sept 2026')
  })
})

describe('getSessions (FR-A5)', () => {
  it('says the list could not be read, rather than claim there are no sessions', async () => {
    client({ rows: null, rpcError: { message: 'permission denied' } })
    expect(await getSessions()).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      { err: 'permission denied' },
      'sessions could not be read',
    )
  })

  it('reads the caller’s own sessions through the database function, as the user', async () => {
    const fake = client()
    expect(await getSessions()).toEqual([])
    expect(fake.rpc).toHaveBeenCalledWith('my_sessions')
  })

  it('names each device, and lists this one first, then the most recently seen', async () => {
    client({
      rows: [
        {
          id: 'older',
          created_at: '2026-09-01T09:00:00Z',
          last_used_at: '2026-09-20T09:00:00Z',
          user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0',
          ip: '102.89.1.2',
          aal: 'aal1',
          is_current: false,
        },
        {
          id: 'newer',
          created_at: '2026-09-22T09:00:00Z',
          last_used_at: '2026-09-24T09:00:00Z',
          user_agent: null,
          ip: null,
          aal: 'aal1',
          is_current: false,
        },
        {
          id: 'this',
          created_at: '2026-09-23T09:00:00Z',
          last_used_at: '2026-09-23T09:00:00Z',
          user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0',
          ip: '105.112.3.4',
          aal: 'aal2',
          is_current: true,
        },
      ],
    })

    expect(await getSessions()).toEqual([
      {
        id: 'this',
        device: 'Chrome on macOS',
        ip: '105.112.3.4',
        signedInAt: '2026-09-23T09:00:00Z',
        lastActiveAt: '2026-09-23T09:00:00Z',
        isCurrent: true,
      },
      {
        id: 'newer',
        device: 'Unknown device',
        ip: null,
        signedInAt: '2026-09-22T09:00:00Z',
        lastActiveAt: '2026-09-24T09:00:00Z',
        isCurrent: false,
      },
      {
        id: 'older',
        device: 'Chrome on Windows',
        ip: '102.89.1.2',
        signedInAt: '2026-09-01T09:00:00Z',
        lastActiveAt: '2026-09-20T09:00:00Z',
        isCurrent: false,
      },
    ])
  })
})

describe('revokeSession (FR-A5)', () => {
  it('refuses a session that has not finished its two-factor sign-in', async () => {
    const fake = client({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' } })

    const result = await revokeSession({ sessionId: OTHER })

    expect(result?.data).toEqual({
      error:
        'Enter the code from your authenticator app to finish signing in, then sign other devices out.',
    })
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('needs a signed-in user', async () => {
    client({ user: null })
    const result = await revokeSession({ sessionId: OTHER })
    expect(result?.serverError).toBe('Please sign in to continue.')
  })

  it('refuses anything but a session id', async () => {
    const fake = client()
    const result = await revokeSession({ sessionId: 'not-a-uuid' })
    expect(result?.validationErrors).toBeDefined()
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('says so when the database could not do it, without its words (N10)', async () => {
    client({ rpcError: { message: 'connection reset' } })
    const result = await revokeSession({ sessionId: OTHER })
    expect(result?.data).toEqual({
      error: 'Something went wrong on our side. Please try again in a moment.',
    })
  })

  it('says a device had already gone when nothing was signed out', async () => {
    client({ revoked: false })
    const result = await revokeSession({ sessionId: OTHER })
    expect(result?.data).toEqual({ error: 'That device was already signed out.' })
  })

  it('signs the other device out through the database function, as the user', async () => {
    const fake = client({ aal: { currentLevel: 'aal2', nextLevel: 'aal2' } })

    const result = await revokeSession({ sessionId: OTHER })

    expect(result?.data).toEqual({ ok: true })
    expect(fake.rpc).toHaveBeenCalledWith('revoke_my_session', { p_session_id: OTHER })
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings')
  })
})

describe('signOutOtherSessions (FR-A5)', () => {
  it('refuses a session that has not finished its two-factor sign-in', async () => {
    const fake = client({ aal: { currentLevel: 'aal1', nextLevel: 'aal2' } })
    const result = await signOutOtherSessions()
    expect(result?.data).toMatchObject({ error: expect.stringContaining('authenticator app') })
    expect(fake.auth.signOut).not.toHaveBeenCalled()
  })

  it('explains a refusal from Supabase in our own words', async () => {
    client({ signOutError: { code: 'over_request_rate_limit' } })
    const result = await signOutOtherSessions()
    expect(result?.data).toEqual({
      error: 'Too many attempts in a short time. Wait a minute, then try again.',
    })
  })

  it('signs out every other session and keeps this one', async () => {
    const fake = client()
    const result = await signOutOtherSessions()
    expect(result?.data).toEqual({ ok: true })
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: 'others' })
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings')
  })
})
