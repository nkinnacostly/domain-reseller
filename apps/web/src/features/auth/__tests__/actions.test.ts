import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { signIn, signUp, sendMagicLink, requestPasswordReset } = await import('../actions/session')
const { completePasswordReset } = await import('../actions/password')
const { disableTwoFactor, startTotpEnrollment } = await import('../actions/two-factor')

const now = () => Math.floor(Date.now() / 1000)
type Method = { method: string; timestamp: number }

/** A Supabase double shaped like the calls our actions make. */
function fake({
  methods = [{ method: 'password', timestamp: now() }] as Method[],
  nextLevel = 'aal1',
  currentLevel = 'aal1',
  passwordResetAt = null as string | null,
} = {}) {
  const ok = async () => ({ data: {}, error: null })
  const profileUpdate = vi.fn(() => ({ eq: async () => ({ error: null }) }))
  const client = {
    auth: {
      signInWithPassword: vi.fn(ok),
      signUp: vi.fn(ok),
      resend: vi.fn(ok),
      signInWithOtp: vi.fn(ok),
      resetPasswordForEmail: vi.fn(ok),
      updateUser: vi.fn(ok),
      signOut: vi.fn(ok),
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel, nextLevel, currentAuthenticationMethods: methods },
        })),
        listFactors: vi.fn(async () => ({
          data: {
            all: [{ id: 'stale', status: 'unverified' }],
            totp: [{ id: 'stale', status: 'unverified' }],
          },
        })),
        unenroll: vi.fn(ok),
        enroll: vi.fn(async () => ({
          data: { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;x', secret: 'ABCD' } },
          error: null,
        })),
        challengeAndVerify: vi.fn(ok),
      },
    },
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { password_reset_at: passwordResetAt } }) }),
      }),
      update: profileUpdate,
    })),
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return { client, profileUpdate }
}

/** Where a Next redirect was headed — it is thrown, not returned. */
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

describe('signIn', () => {
  it('reports a wrong password without redirecting anywhere', async () => {
    const { client } = fake()
    client.auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { code: 'invalid_credentials' },
    } as never)
    const result = await signIn({ email: 'ada@example.com', password: 'nope' })
    expect(result?.data).toEqual({ error: expect.stringMatching(/don't match/) })
  })

  it('goes where the person was headed', async () => {
    fake()
    expect(
      await redirectTarget(
        signIn({ email: 'ada@example.com', password: 'pw', next: '/app/settings' }),
      ),
    ).toBe('/app/settings')
  })

  it('ignores a next that points off-site', async () => {
    fake()
    expect(
      await redirectTarget(
        signIn({ email: 'ada@example.com', password: 'pw', next: 'https://evil.example' }),
      ),
    ).toBe('/app/domains')
  })

  it('stops at the second factor when the account has one', async () => {
    fake({ nextLevel: 'aal2', currentLevel: 'aal1' })
    expect(
      await redirectTarget(
        signIn({ email: 'ada@example.com', password: 'pw', next: '/app/settings' }),
      ),
    ).toBe('/verify?next=%2Fapp%2Fsettings')
  })

  it('rejects a malformed email before calling Supabase', async () => {
    const { client } = fake()
    const result = await signIn({ email: 'not-an-email', password: 'pw' })
    expect(result?.validationErrors).toBeDefined()
    expect(client.auth.signInWithPassword).not.toHaveBeenCalled()
  })
})

describe('signUp', () => {
  it('sends the confirmation link through our callback and stores the name', async () => {
    const { client } = fake()
    const result = await signUp({
      fullName: 'Ada Okafor',
      email: 'Ada@Example.com',
      password: 'long-enough-1',
    })

    expect(result?.data).toEqual({ sentTo: 'ada@example.com' })
    const [args] = client.auth.signUp.mock.calls[0] as unknown as [
      { options: { emailRedirectTo: string; data: { full_name: string } } },
    ]
    expect(args.options.data.full_name).toBe('Ada Okafor')
    expect(args.options.emailRedirectTo).toMatch(
      /\/auth\/callback\?flow=signup&next=%2Fapp%2Fdomains$/,
    )
  })
})

describe('email links never reveal who has an account', () => {
  it('answers a magic-link request for an unknown address like any other', async () => {
    const { client } = fake()
    client.auth.signInWithOtp.mockResolvedValueOnce({
      data: {},
      error: { code: 'otp_disabled' },
    } as never)
    expect((await sendMagicLink({ email: 'nobody@example.com' }))?.data).toEqual({
      sentTo: 'nobody@example.com',
    })
  })

  it('still reports a rate limit, which is about the sender, not the address', async () => {
    const { client } = fake()
    client.auth.resetPasswordForEmail.mockResolvedValueOnce({
      data: {},
      error: { code: 'over_email_send_rate_limit' },
    } as never)
    expect((await requestPasswordReset({ email: 'ada@example.com' }))?.data).toEqual({
      error: expect.stringMatching(/Wait a few minutes/),
    })
  })
})

describe('completePasswordReset (FR-A6)', () => {
  it('refuses a session that did not come from a reset link', async () => {
    const { client } = fake({ methods: [{ method: 'password', timestamp: now() }] })
    const result = await completePasswordReset({
      password: 'brand-new-pass',
      confirm: 'brand-new-pass',
    })
    expect(result?.data).toEqual({ error: expect.stringMatching(/reset link/) })
    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('sets the password, starts the 24-hour hold and signs out every other device', async () => {
    const { client } = fake({ methods: [{ method: 'otp', timestamp: now() }] })
    const service = {
      from: vi.fn(() => ({ update: vi.fn(() => ({ eq: async () => ({ error: null }) })) })),
    }
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const target = await redirectTarget(
      completePasswordReset({ password: 'brand-new-pass', confirm: 'brand-new-pass' }),
    )

    expect(client.auth.updateUser).toHaveBeenCalledWith({ password: 'brand-new-pass' })
    expect(service.from).toHaveBeenCalledWith('profiles')
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' })
    expect(target).toBe('/app/settings?reset=1')
  })
})

describe('two-factor changes', () => {
  it('cannot be turned on from an email-link session', async () => {
    const { client } = fake({ methods: [{ method: 'otp', timestamp: now() }] })
    const result = await startTotpEnrollment()
    expect(result?.data).toEqual({ error: expect.stringMatching(/Sign in with your password/) })
    expect(client.auth.mfa.enroll).not.toHaveBeenCalled()
  })

  it('cannot be turned on during the post-reset hold', async () => {
    const { client } = fake({ passwordResetAt: new Date().toISOString() })
    const result = await startTotpEnrollment()
    expect(result?.data).toEqual({ error: expect.stringMatching(/paused for 24 hours/) })
    expect(client.auth.mfa.enroll).not.toHaveBeenCalled()
  })

  it('clears an abandoned set-up before starting a new one', async () => {
    const { client } = fake()
    const result = await startTotpEnrollment()
    expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'stale' })
    expect(result?.data).toEqual({
      factorId: 'factor-1',
      qrCode: 'data:image/svg+xml;x',
      secret: 'ABCD',
    })
  })

  it('asks for a fresh code before turning it off (FR-A3)', async () => {
    const stale = now() - 20 * 60
    const { client } = fake({
      currentLevel: 'aal2',
      methods: [
        { method: 'totp', timestamp: stale },
        { method: 'password', timestamp: stale },
      ],
    })
    const result = await disableTwoFactor({ factorId: 'factor-1' })
    expect(result?.data).toEqual({ verify: true })
    expect(client.auth.mfa.unenroll).not.toHaveBeenCalled()
  })
})
