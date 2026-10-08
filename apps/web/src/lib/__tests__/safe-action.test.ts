import { AppError } from '@dr/shared/errors'
import { headers } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import {
  actionClient,
  authAction,
  elevatedAction,
  partialAuthAction,
  SIGN_IN_UNFINISHED,
} from '../safe-action'

vi.mock('next/headers', () => ({ headers: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const nowSeconds = () => Math.floor(Date.now() / 1000)
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

type Session = {
  user?: { id: string } | null
  aal?: {
    currentLevel: string
    nextLevel?: string
    currentAuthenticationMethods?: unknown[]
  } | null
  profile?: { password_reset_at: string | null } | null
}

/** A Supabase session as the server client would see it. */
function session({
  user = { id: 'user-1' },
  aal = {
    currentLevel: 'aal2',
    currentAuthenticationMethods: [
      { method: 'password', timestamp: nowSeconds() - 3600 },
      { method: 'totp', timestamp: nowSeconds() - 60 },
    ],
  },
  profile = { password_reset_at: null },
}: Session = {}) {
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: profile }) }) }),
  }))
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: aal }) },
    },
    from,
  } as never)
  return { from }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(headers).mockResolvedValue(new Headers() as never)
})

describe('actionClient', () => {
  const requestId = actionClient.action(async ({ ctx }) => ctx.requestId)

  it("carries the request's own id, so logs from one request can be joined", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ 'x-request-id': 'req-42' }) as never)
    expect(await requestId()).toEqual({ data: 'req-42' })
  })

  it('makes up a request id when the platform did not send one', async () => {
    const result = await requestId()
    expect(result.data).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('shows an AppError message to the user as it is', async () => {
    const conflict = actionClient.action(async () => {
      throw new AppError('CONFLICT', 'That domain was just taken.')
    })
    expect(await conflict()).toEqual({ serverError: 'That domain was just taken.' })
  })

  it('never shows the user an unexpected error, only a generic apology (N10)', async () => {
    const crash = actionClient.action(async () => {
      throw new Error('relation "orders" does not exist')
    })
    const result = await crash()
    expect(result.serverError).toBe('Something went wrong on our end. Please try again.')
    expect(JSON.stringify(result)).not.toContain('orders')
  })
})

describe('authAction', () => {
  const whoAmI = authAction.action(async ({ ctx }) => ctx.user.id)

  it('refuses a visitor who is not signed in, before the action runs', async () => {
    session({ user: null })
    const body = vi.fn()
    const action = authAction.action(async () => body())

    expect(await action()).toEqual({ serverError: 'Please sign in to continue.' })
    expect(body).not.toHaveBeenCalled()
  })

  it('hands the action the signed-in user', async () => {
    session()
    expect(await whoAmI()).toEqual({ data: 'user-1' })
  })

  it('refuses a session with two-factor on whose code is not entered yet (security audit)', async () => {
    session({ aal: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] } })
    const body = vi.fn()
    const action = authAction.action(async () => body())
    expect(await action()).toEqual({ serverError: SIGN_IN_UNFINISHED })
    expect(body).not.toHaveBeenCalled()
  })

  it('lets a password-only session through when there is no second factor to enter', async () => {
    session({ aal: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] } })
    expect(await whoAmI()).toEqual({ data: 'user-1' })
  })
})

describe('partialAuthAction (finishing sign-in)', () => {
  it('lets a session that has not entered its code yet through — to enter it, or sign out', async () => {
    session({ aal: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] } })
    expect(await partialAuthAction.action(async ({ ctx }) => ctx.user.id)()).toEqual({
      data: 'user-1',
    })
  })

  it('still needs someone signed in', async () => {
    session({ user: null })
    expect(await partialAuthAction.action(async () => 1)()).toEqual({
      serverError: 'Please sign in to continue.',
    })
  })
})

describe('elevatedAction (SEC-2)', () => {
  const sensitive = elevatedAction.action(async ({ ctx }) => ctx.user.id)
  const MFA = "Confirm it's you with the code from your authenticator app to continue."

  it('lets a fresh second factor through', async () => {
    const { from } = session()
    expect(await sensitive()).toEqual({ data: 'user-1' })
    expect(from).toHaveBeenCalledWith('profiles')
  })

  it.each([
    ['a password-only session', { currentLevel: 'aal1', currentAuthenticationMethods: [] }],
    ['no assurance level at all', null],
    [
      'a second factor older than fifteen minutes',
      {
        currentLevel: 'aal2',
        currentAuthenticationMethods: [{ method: 'totp', timestamp: nowSeconds() - 16 * 60 }],
      },
    ],
    ['an aal2 session that lists no methods', { currentLevel: 'aal2' }],
  ])('asks for the authenticator code on %s', async (_, aal) => {
    session({ aal })
    expect(await sensitive()).toEqual({ serverError: MFA })
  })

  it('tells an account with no authenticator to turn two-factor on, not to enter a code (FR-A2)', async () => {
    session({ aal: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] } })
    const body = vi.fn()
    const action = elevatedAction.action(async () => body())
    expect(await action()).toEqual({
      serverError:
        'Changes like this need two-factor authentication on your account. Turn it on in Settings, under Two-factor authentication, then try again.',
    })
    expect(body).not.toHaveBeenCalled()
  })

  it('asks to finish signing in when an authenticator is set up but its code not entered', async () => {
    session({ aal: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] } })
    expect(await sensitive()).toEqual({ serverError: SIGN_IN_UNFINISHED })
  })

  it('holds sensitive changes for a day after a password reset (FR-A6)', async () => {
    session({ profile: { password_reset_at: hoursAgo(1) } })
    const result = await sensitive()
    expect(result.serverError).toMatch(/paused for 24 hours after a password reset — until /)
    expect(result.data).toBeUndefined()
  })

  it('lifts the hold once the day has passed', async () => {
    session({ profile: { password_reset_at: hoursAgo(25) } })
    expect(await sensitive()).toEqual({ data: 'user-1' })
  })

  it('treats a missing profile row as no reset', async () => {
    session({ profile: null })
    expect(await sensitive()).toEqual({ data: 'user-1' })
  })

  it('still requires a signed-in user first', async () => {
    session({ user: null })
    expect(await sensitive()).toEqual({ serverError: 'Please sign in to continue.' })
  })
})
