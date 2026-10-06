import { createClient as createStandaloneClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { verifyTurnstile } from '@/lib/turnstile'
import { FALLBACK_MESSAGE } from '../lib/messages'

/**
 * Mail's auth actions against a Supabase double shaped like the calls they
 * make (the shop's approach): Supabase Auth is the boundary; the shop's
 * security notices and hold are their own module, tested on the wire.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0' }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/turnstile', async (original) => ({
  ...(await original<typeof import('@/lib/turnstile')>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, skipped: true })),
}))
vi.mock('../queries/notices', () => ({
  noteSignIn: vi.fn(),
  queueAccountNotice: vi.fn(),
  recordResetHold: vi.fn(),
}))

const { noteSignIn, queueAccountNotice, recordResetHold } = await import('../queries/notices')
const { signIn, signUp, resendConfirmation, requestPasswordReset, signOut } = await import(
  '../actions/session'
)
const { continueWithGoogle } = await import('../actions/oauth')
const { completePasswordReset, changePassword } = await import('../actions/password')
const { startTotpEnrollment, confirmTotpEnrollment, disableTwoFactor, verifySecondFactor } =
  await import('../actions/two-factor')

const now = () => Math.floor(Date.now() / 1000)
type Method = { method: string; timestamp: number }

function fake({
  methods = [{ method: 'password', timestamp: now() }] as Method[],
  nextLevel = 'aal1',
  currentLevel = 'aal1',
  resetAt = null as string | null,
  holdUnreadable = false,
  factors = [{ id: 'stale', status: 'unverified' }] as { id: string; status: string }[],
} = {}) {
  const ok = async () => ({ data: {}, error: null })
  const client = {
    auth: {
      signInWithPassword: vi.fn(ok),
      signUp: vi.fn(ok),
      resend: vi.fn(ok),
      resetPasswordForEmail: vi.fn(ok),
      signInWithOAuth: vi.fn(async () => ({
        data: { url: 'https://example.supabase.co/auth/v1/authorize?provider=google' },
        error: null,
      })),
      updateUser: vi.fn(ok),
      signOut: vi.fn(ok),
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1', email: 'ada@example.com', app_metadata: {} } },
      })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel, nextLevel, currentAuthenticationMethods: methods },
        })),
        listFactors: vi.fn(async () => ({ data: { all: factors, totp: factors } })),
        unenroll: vi.fn(ok),
        enroll: vi.fn(async () => ({
          data: { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;x', secret: 'ABCD' } },
          error: null,
        })),
        challengeAndVerify: vi.fn(ok),
      },
    },
    schema: vi.fn(() => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              holdUnreadable
                ? { data: null, error: { code: '42501' } }
                : { data: { password_reset_at: resetAt }, error: null },
          }),
        }),
      }),
    })),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return client
}

async function redirectTarget(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? ''
    if (digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2] ?? ''
    throw error
  }
  throw new Error('expected a redirect')
}

beforeEach(() => vi.clearAllMocks())

describe('signIn (MAIL-SPEC §7.1)', () => {
  it('says a wrong password, and goes nowhere', async () => {
    const client = fake()
    client.auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { code: 'invalid_credentials' },
    } as never)
    expect((await signIn({ email: 'ada@example.com', password: 'nope' }))?.data).toEqual({
      error: expect.stringMatching(/don't match/),
    })
    expect(noteSignIn).not.toHaveBeenCalled()
  })

  it('goes where the person was headed, and notes the device for the shop’s notice', async () => {
    const client = fake()
    client.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    } as never)
    expect(
      await redirectTarget(
        signIn({ email: 'ada@example.com', password: 'pw', next: '/invite?token=abc' }),
      ),
    ).toBe('/invite?token=abc')
    expect(noteSignIn).toHaveBeenCalledWith('user-1', 'Mozilla/5.0 (Macintosh) Chrome/140.0')
  })

  it('lands on the dashboard rather than off-site', async () => {
    fake()
    expect(
      await redirectTarget(
        signIn({ email: 'ada@example.com', password: 'pw', next: 'https://evil.example' }),
      ),
    ).toBe('/dashboard')
  })

  it('stops at the two-factor code when the sign-in has one', async () => {
    fake({ nextLevel: 'aal2' })
    expect(
      await redirectTarget(
        signIn({ email: 'ada@example.com', password: 'pw', next: '/dashboard' }),
      ),
    ).toBe('/verify?next=%2Fdashboard')
  })
})

describe('signUp and the emails it sends', () => {
  it('asks Turnstile first, and sends nothing when it refuses', async () => {
    const client = fake()
    vi.mocked(verifyTurnstile).mockResolvedValueOnce({ ok: false, reason: 'refused' })
    const result = await signUp({
      fullName: 'Ada',
      email: 'ada@example.com',
      password: 'long-enough-1',
    })
    expect(result?.data).toEqual({ error: "We couldn't confirm you're a person. Try again." })
    expect(client.auth.signUp).not.toHaveBeenCalled()
  })

  it('stores the name and sends the link back to Mail, to land where the person was going', async () => {
    const client = fake()
    const result = await signUp({
      fullName: 'Ada Okafor',
      email: 'Ada@Example.com',
      password: 'long-enough-1',
      next: '/invite?token=abc',
    })
    expect(result?.data).toEqual({ sentTo: 'ada@example.com' })
    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'long-enough-1',
      options: {
        emailRedirectTo: 'http://localhost:3001/invite?token=abc',
        data: { full_name: 'Ada Okafor' },
      },
    })
  })

  it('words a Supabase refusal, never its raw text', async () => {
    const client = fake()
    client.auth.signUp.mockResolvedValueOnce({ data: {}, error: { code: 'weird' } } as never)
    expect(
      (await signUp({ fullName: 'Ada', email: 'ada@example.com', password: 'long-enough-1' }))
        ?.data,
    ).toEqual({ error: FALLBACK_MESSAGE })
  })

  it('sends the confirmation again behind the same check', async () => {
    const client = fake()
    expect((await resendConfirmation({ email: 'ada@example.com' }))?.data).toEqual({
      sentTo: 'ada@example.com',
    })
    expect(client.auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'ada@example.com',
      options: { emailRedirectTo: 'http://localhost:3001/dashboard' },
    })
    client.auth.resend.mockResolvedValueOnce({
      data: {},
      error: { code: 'over_email_send_rate_limit' },
    } as never)
    expect((await resendConfirmation({ email: 'ada@example.com' }))?.data).toEqual({
      error: expect.stringMatching(/Wait a few minutes/),
    })
    vi.mocked(verifyTurnstile).mockResolvedValueOnce({ ok: false, reason: 'missing' })
    expect((await resendConfirmation({ email: 'ada@example.com' }))?.data).toEqual({
      error: expect.stringMatching(/Verify you are human/),
    })
  })

  it('answers a reset for an unknown address like any other, and still reports a rate limit', async () => {
    const client = fake()
    client.auth.resetPasswordForEmail.mockResolvedValueOnce({
      data: {},
      error: { code: 'user_not_found' },
    } as never)
    expect((await requestPasswordReset({ email: 'nobody@example.com' }))?.data).toEqual({
      sentTo: 'nobody@example.com',
    })
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('nobody@example.com', {
      redirectTo: 'http://localhost:3001/reset-password',
    })
    client.auth.resetPasswordForEmail.mockResolvedValueOnce({
      data: {},
      error: { code: 'over_request_rate_limit' },
    } as never)
    expect((await requestPasswordReset({ email: 'ada@example.com' }))?.data).toEqual({
      error: expect.stringMatching(/Too many attempts/),
    })
    vi.mocked(verifyTurnstile).mockResolvedValueOnce({ ok: false, reason: 'unanswered' })
    expect((await requestPasswordReset({ email: 'ada@example.com' }))?.data).toEqual({
      error: expect.stringMatching(/didn't answer/),
    })
  })

  it('signs out this device only, then goes home', async () => {
    const client = fake()
    expect(await redirectTarget(signOut())).toBe('/')
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

describe('continueWithGoogle', () => {
  it('hands the browser to Supabase, back to Mail’s callback, asking which account', async () => {
    const client = fake()
    expect(await redirectTarget(continueWithGoogle({ next: '/dashboard/settings' }))).toMatch(
      /^https:\/\/example\.supabase\.co\/auth\/v1\/authorize/,
    )
    expect(client.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'http://localhost:3001/auth/callback?flow=oauth&next=%2Fdashboard%2Fsettings',
        skipBrowserRedirect: true,
        queryParams: { prompt: 'select_account' },
      },
    })
  })

  it('says so when Google cannot start', async () => {
    const client = fake()
    client.auth.signInWithOAuth.mockResolvedValueOnce({
      data: {},
      error: { message: 'x' },
    } as never)
    expect((await continueWithGoogle({}))?.data).toEqual({
      error: 'Google sign-in is not available just now. Use your email instead.',
    })
  })
})

describe('completePasswordReset (the shop’s FR-A6, for a shared sign-in)', () => {
  it('refuses a session that did not come from a reset link', async () => {
    const client = fake()
    const result = await completePasswordReset({
      password: 'brand-new-pass',
      confirm: 'brand-new-pass',
    })
    expect(result?.data).toEqual({ error: expect.stringMatching(/reset link/) })
    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('sets the password, starts the shop’s hold, queues the notice and signs out the rest', async () => {
    const client = fake({ methods: [{ method: 'otp', timestamp: now() }] })
    expect(
      await redirectTarget(
        completePasswordReset({ password: 'brand-new-pass', confirm: 'brand-new-pass' }),
      ),
    ).toBe('/dashboard/settings/security?reset=1')
    expect(client.auth.updateUser).toHaveBeenCalledWith({ password: 'brand-new-pass' })
    expect(recordResetHold).toHaveBeenCalledWith('user-1')
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'password_changed')
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' })
  })

  it('says why Supabase refused the new password, and holds nothing', async () => {
    const client = fake({ methods: ['otp'] as unknown as Method[] })
    client.auth.updateUser.mockResolvedValueOnce({
      data: {},
      error: { code: 'weak_password' },
    } as never)
    expect(
      (await completePasswordReset({ password: 'brand-new-pass', confirm: 'brand-new-pass' }))
        ?.data,
    ).toEqual({ error: expect.stringMatching(/stronger password/) })
    expect(recordResetHold).not.toHaveBeenCalled()
  })
})

describe('changePassword', () => {
  function verifier(error: { code: string } | null) {
    const standalone = {
      auth: {
        signInWithPassword: vi.fn(async () => ({ data: {}, error })),
        signOut: vi.fn(async () => ({ error: null })),
      },
    }
    vi.mocked(createStandaloneClient).mockReturnValue(standalone as never)
    return standalone
  }
  const input = { current: 'old-password', password: 'brand-new-pass', confirm: 'brand-new-pass' }

  it('checks the current password on a throwaway client, then changes it', async () => {
    const client = fake()
    const standalone = verifier(null)
    expect((await changePassword(input))?.data).toEqual({ ok: true })
    expect(standalone.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'old-password',
    })
    expect(client.auth.updateUser).toHaveBeenCalledWith({ password: 'brand-new-pass' })
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'password_changed')
  })

  it('says the current password is wrong, with a hint for a Google sign-in', async () => {
    const client = fake()
    verifier({ code: 'invalid_credentials' })
    expect((await changePassword(input))?.data).toEqual({
      error: "That isn't your current password.",
    })
    client.auth.getUser.mockResolvedValueOnce({
      data: {
        user: { id: 'user-1', email: 'ada@example.com', app_metadata: { providers: ['google'] } },
      },
    } as never)
    expect((await changePassword(input))?.data).toEqual({
      error: expect.stringMatching(/signed up with Google/),
    })
    verifier({ code: 'over_request_rate_limit' })
    expect((await changePassword(input))?.data).toEqual({
      error: expect.stringMatching(/Too many attempts/),
    })
    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('reports a refused change, and a sign-in with no address', async () => {
    const client = fake()
    verifier(null)
    client.auth.updateUser.mockResolvedValueOnce({
      data: {},
      error: { code: 'same_password' },
    } as never)
    expect((await changePassword(input))?.data).toEqual({
      error: "That's your current password. Choose a new one.",
    })
    client.auth.getUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } } as never)
    expect((await changePassword(input))?.data).toEqual({ error: FALLBACK_MESSAGE })
  })
})

describe('two-factor, for the shared sign-in', () => {
  it('starts a set-up after clearing a half-finished one', async () => {
    const client = fake()
    expect((await startTotpEnrollment())?.data).toEqual({
      factorId: 'factor-1',
      qrCode: 'data:image/svg+xml;x',
      secret: 'ABCD',
    })
    expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'stale' })
    expect(client.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: 'Authenticator app',
      issuer: 'MyDomainsHub',
    })
  })

  it('refuses from an email-link session, during the shop’s hold, or when it is already on', async () => {
    fake({ methods: [{ method: 'otp', timestamp: now() }] })
    expect((await startTotpEnrollment())?.data).toEqual({
      error: expect.stringMatching(/Sessions started from an email link/),
    })
    fake({ resetAt: new Date().toISOString() })
    expect((await startTotpEnrollment())?.data).toEqual({
      error: expect.stringMatching(/paused for 24 hours/),
    })
    // A hold that cannot be read counts as one just started.
    fake({ holdUnreadable: true })
    expect((await startTotpEnrollment())?.data).toEqual({
      error: expect.stringMatching(/paused for 24 hours/),
    })
    fake({ factors: [{ id: 'f', status: 'verified' }] })
    expect((await startTotpEnrollment())?.data).toEqual({
      error: 'Two-factor authentication is already on for your sign-in.',
    })
  })

  it('reports an enrolment Supabase refused', async () => {
    const client = fake({ resetAt: '2020-01-01T00:00:00Z' })
    client.auth.mfa.enroll.mockResolvedValueOnce({ data: null, error: { code: 'x' } } as never)
    expect((await startTotpEnrollment())?.data).toEqual({ error: FALLBACK_MESSAGE })
  })

  it('confirms with a code, queues the notice, and words a wrong code', async () => {
    const client = fake()
    expect((await confirmTotpEnrollment({ factorId: 'factor-1', code: '123 456' }))?.data).toEqual({
      ok: true,
    })
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'factor-1',
      code: '123456',
    })
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'two_factor_on')
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/settings/security')
    client.auth.mfa.challengeAndVerify.mockResolvedValueOnce({
      data: {},
      error: { code: 'mfa_verification_failed' },
    } as never)
    expect((await confirmTotpEnrollment({ factorId: 'factor-1', code: '000000' }))?.data).toEqual({
      error: expect.stringMatching(/newest one/),
    })
  })

  it('turns it off only after a fresh code, and not during the hold', async () => {
    fake()
    expect((await disableTwoFactor({ factorId: 'f' }))?.data).toEqual({ verify: true })
    const fresh = [
      { method: 'password', timestamp: now() },
      { method: 'totp', timestamp: now() },
    ]
    fake({ methods: fresh, resetAt: new Date().toISOString() })
    expect((await disableTwoFactor({ factorId: 'f' }))?.data).toEqual({
      error: expect.stringMatching(/paused/),
    })
    const client = fake({ methods: fresh })
    expect((await disableTwoFactor({ factorId: 'f' }))?.data).toEqual({ ok: true })
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'two_factor_off')
    client.auth.mfa.unenroll.mockResolvedValueOnce({ data: {}, error: { code: 'x' } } as never)
    expect((await disableTwoFactor({ factorId: 'f' }))?.data).toEqual({ error: FALLBACK_MESSAGE })
  })

  it('verifies the second step and goes on; with no authenticator there is nothing to ask', async () => {
    const client = fake({ factors: [{ id: 'f', status: 'verified' }] })
    expect(
      await redirectTarget(verifySecondFactor({ code: '123456', next: '/dashboard/emails' })),
    ).toBe('/dashboard/emails')
    client.auth.mfa.challengeAndVerify.mockResolvedValueOnce({
      data: {},
      error: { code: 'mfa_challenge_expired' },
    } as never)
    expect((await verifySecondFactor({ code: '123456' }))?.data).toEqual({
      error: expect.stringMatching(/expired/),
    })
    fake({ factors: [] })
    expect(await redirectTarget(verifySecondFactor({ code: '123456' }))).toBe('/dashboard')
  })
})
