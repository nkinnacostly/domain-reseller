import { createClient as createStandaloneClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { FALLBACK_MESSAGE } from '../lib/messages'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/140.0' }),
}))
vi.mock('../queries/notices', () => ({ noteSignIn: vi.fn(), queueAccountNotice: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { noteSignIn, queueAccountNotice } = await import('../queries/notices')
const { signIn, signUp, sendMagicLink, requestPasswordReset, resendConfirmation, signOut } =
  await import('../actions/session')
const { completePasswordReset, changePassword } = await import('../actions/password')
const { updateProfile } = await import('../actions/profile')
const { confirmTotpEnrollment, disableTwoFactor, startTotpEnrollment, verifySecondFactor } =
  await import('../actions/two-factor')

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
    expect(noteSignIn).not.toHaveBeenCalled()
  })

  it('goes where the person was headed', async () => {
    fake()
    expect(
      await redirectTarget(
        signIn({ email: 'ada@example.com', password: 'pw', next: '/app/settings' }),
      ),
    ).toBe('/app/settings')
  })

  it('notes the device it signed in from, for the new-device notice (SEC-4)', async () => {
    const { client } = fake()
    client.auth.signInWithPassword.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    } as never)
    await redirectTarget(signIn({ email: 'ada@example.com', password: 'pw' }))
    expect(noteSignIn).toHaveBeenCalledWith('user-1', 'Mozilla/5.0 (Macintosh) Chrome/140.0')
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
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'password_changed')
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

/** Every auth action runs behind the same gate. */
describe('a signed-out visitor', () => {
  it('is asked to sign in, and nothing is written', async () => {
    const { client, profileUpdate } = fake()
    client.auth.getUser.mockResolvedValueOnce({ data: { user: null } } as never)
    const result = await updateProfile({ fullName: 'Ada Okafor' })
    expect(result?.serverError).toBe('Please sign in to continue.')
    expect(profileUpdate).not.toHaveBeenCalled()
  })
})

describe('signUp failures', () => {
  it('explains a refused sign-up in plain words', async () => {
    const { client } = fake()
    client.auth.signUp.mockResolvedValueOnce({
      data: {},
      error: { code: 'signup_disabled' },
    } as never)
    const result = await signUp({
      fullName: 'Ada Okafor',
      email: 'ada@example.com',
      password: 'long-enough-1',
    })
    expect(result?.data).toEqual({ error: expect.stringMatching(/sign-ups are paused/) })
  })

  it('refuses a short password before calling Supabase', async () => {
    const { client } = fake()
    const result = await signUp({ fullName: 'Ada Okafor', email: 'ada@example.com', password: 'x' })
    expect(result?.validationErrors).toBeDefined()
    expect(client.auth.signUp).not.toHaveBeenCalled()
  })
})

describe('resendConfirmation', () => {
  it('sends the confirmation again through our callback, keeping where they were headed', async () => {
    const { client } = fake()
    const result = await resendConfirmation({ email: 'ada@example.com', next: '/cart' })
    expect(result?.data).toEqual({ sentTo: 'ada@example.com' })
    expect(client.auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'ada@example.com',
      options: { emailRedirectTo: expect.stringMatching(/flow=signup&next=%2Fcart$/) },
    })
  })

  it('reports a rate limit instead of pretending it sent', async () => {
    const { client } = fake()
    client.auth.resend.mockResolvedValueOnce({
      data: {},
      error: { code: 'over_email_send_rate_limit' },
    } as never)
    expect((await resendConfirmation({ email: 'ada@example.com' }))?.data).toEqual({
      error: expect.stringMatching(/Wait a few minutes/),
    })
  })
})

describe('sendMagicLink', () => {
  it('never creates an account from a sign-in link', async () => {
    const { client } = fake()
    const result = await sendMagicLink({ email: 'ada@example.com', next: '/app/settings' })
    expect(result?.data).toEqual({ sentTo: 'ada@example.com' })
    expect(client.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'ada@example.com',
      options: {
        shouldCreateUser: false,
        emailRedirectTo: expect.stringMatching(/flow=magiclink&next=%2Fapp%2Fsettings$/),
      },
    })
  })

  it('reports a rate limit on sign-in links', async () => {
    const { client } = fake()
    client.auth.signInWithOtp.mockResolvedValueOnce({
      data: {},
      error: { code: 'over_request_rate_limit' },
    } as never)
    expect((await sendMagicLink({ email: 'ada@example.com' }))?.data).toEqual({
      error: expect.stringMatching(/Too many attempts/),
    })
  })
})

describe('requestPasswordReset', () => {
  it('sends the reset link to the reset page through our callback', async () => {
    const { client } = fake()
    const result = await requestPasswordReset({ email: 'ada@example.com' })
    expect(result?.data).toEqual({ sentTo: 'ada@example.com' })
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith('ada@example.com', {
      redirectTo: expect.stringMatching(/flow=recovery&next=%2Freset-password$/),
    })
  })
})

describe('signOut', () => {
  it('signs out this device only and returns home', async () => {
    const { client } = fake()
    expect(await redirectTarget(signOut())).toBe('/')
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

describe('completePasswordReset failures', () => {
  it('reports a rejected password and starts no hold', async () => {
    const { client } = fake({ methods: [{ method: 'otp', timestamp: now() }] })
    client.auth.updateUser.mockResolvedValueOnce({
      data: {},
      error: { code: 'weak_password' },
    } as never)
    const result = await completePasswordReset({
      password: 'brand-new-pass',
      confirm: 'brand-new-pass',
    })
    expect(result?.data).toEqual({ error: expect.stringMatching(/stronger password/) })
    expect(createServiceClient).not.toHaveBeenCalled()
    expect(client.auth.signOut).not.toHaveBeenCalled()
  })

  it('still signs out other devices if the hold could not be recorded', async () => {
    const { client } = fake({ methods: [{ method: 'otp', timestamp: now() }] })
    const service = {
      from: vi.fn(() => ({
        update: vi.fn(() => ({ eq: async () => ({ error: { message: 'connection reset' } }) })),
      })),
    }
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const target = await redirectTarget(
      completePasswordReset({ password: 'brand-new-pass', confirm: 'brand-new-pass' }),
    )
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' })
    expect(target).toBe('/app/settings?reset=1')
  })

  it('treats a session with no recorded sign-in method as not from a reset link', async () => {
    const { client } = fake()
    client.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({ data: null } as never)
    const result = await completePasswordReset({
      password: 'brand-new-pass',
      confirm: 'brand-new-pass',
    })
    expect(result?.data).toEqual({ error: expect.stringMatching(/reset link/) })
  })

  it('refuses mismatched passwords before touching the account', async () => {
    const { client } = fake({ methods: [{ method: 'otp', timestamp: now() }] })
    const result = await completePasswordReset({
      password: 'brand-new-pass',
      confirm: 'brand-new-pas',
    })
    expect(result?.validationErrors).toMatchObject({
      confirm: { _errors: ["The passwords don't match"] },
    })
    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })
})

describe('changePassword', () => {
  /** The throwaway client that checks the current password. */
  function verifier(error: { code: string } | null = null) {
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

  it('changes the password and signs out every other device', async () => {
    const { client } = fake()
    const standalone = verifier()

    const result = await changePassword(input)

    expect(result?.data).toEqual({ ok: true })
    expect(standalone.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'old-password',
    })
    expect(client.auth.updateUser).toHaveBeenCalledWith({ password: 'brand-new-pass' })
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'password_changed')
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' })
  })

  it('checks the current password without replacing this browser’s session', async () => {
    fake()
    const standalone = verifier()
    await changePassword(input)

    const [, , options] = vi.mocked(createStandaloneClient).mock.calls[0] as unknown as [
      string,
      string,
      { auth: { persistSession: boolean; autoRefreshToken: boolean } },
    ]
    expect(options.auth).toEqual({ persistSession: false, autoRefreshToken: false })
    expect(standalone.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('says plainly when the current password is wrong, and changes nothing', async () => {
    const { client } = fake()
    verifier({ code: 'invalid_credentials' })

    const result = await changePassword(input)

    expect(result?.data).toEqual({ error: "That isn't your current password." })
    expect(client.auth.updateUser).not.toHaveBeenCalled()
    expect(client.auth.signOut).not.toHaveBeenCalled()
  })

  it('tells someone who signed up with Google how to create a password (FR-A1)', async () => {
    const { client } = fake()
    client.auth.getUser.mockResolvedValueOnce({
      data: {
        user: { id: 'user-1', email: 'ada@example.com', app_metadata: { providers: ['google'] } },
      },
    } as never)
    verifier({ code: 'invalid_credentials' })

    const result = await changePassword(input)

    expect(result?.data).toEqual({
      error: expect.stringMatching(/signed up with Google and never set one/),
    })
    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('passes on other reasons the check failed, such as a rate limit', async () => {
    const { client } = fake()
    verifier({ code: 'over_request_rate_limit' })

    const result = await changePassword(input)

    expect(result?.data).toEqual({ error: expect.stringMatching(/Too many attempts/) })
    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('reports a rejected new password and keeps other devices signed in', async () => {
    const { client } = fake()
    verifier()
    client.auth.updateUser.mockResolvedValueOnce({
      data: {},
      error: { code: 'same_password' },
    } as never)

    const result = await changePassword(input)

    expect(result?.data).toEqual({ error: expect.stringMatching(/your current password/) })
    expect(client.auth.signOut).not.toHaveBeenCalled()
  })

  it('cannot check a password for an account with no email address', async () => {
    const { client } = fake()
    client.auth.getUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } } as never)

    const result = await changePassword(input)

    expect(result?.data).toEqual({ error: FALLBACK_MESSAGE })
    expect(createStandaloneClient).not.toHaveBeenCalled()
  })

  it('refuses mismatched new passwords before checking anything', async () => {
    fake()
    const result = await changePassword({ ...input, confirm: 'something-else' })
    expect(result?.validationErrors).toMatchObject({
      confirm: { _errors: ["The passwords don't match"] },
    })
    expect(createStandaloneClient).not.toHaveBeenCalled()
  })
})

describe('updateProfile', () => {
  it('saves the name and phone as the user, then refreshes Settings', async () => {
    const { client, profileUpdate } = fake()
    const result = await updateProfile({ fullName: '  Ada Okafor ', phone: '+234 803 123 4567' })

    expect(result?.data).toEqual({ ok: true })
    expect(client.from).toHaveBeenCalledWith('profiles')
    expect(profileUpdate).toHaveBeenCalledWith({
      full_name: 'Ada Okafor',
      phone: '+234 803 123 4567',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings')
  })

  it('clears the phone number when the field is left empty', async () => {
    const { profileUpdate } = fake()
    await updateProfile({ fullName: 'Ada Okafor', phone: '' })
    expect(profileUpdate).toHaveBeenCalledWith({ full_name: 'Ada Okafor', phone: null })
  })

  it('shows a general failure, not the database error, when the save fails', async () => {
    const { profileUpdate } = fake()
    profileUpdate.mockReturnValueOnce({
      eq: async () => ({ error: { message: 'permission denied for column' } }),
    } as never)

    const result = await updateProfile({ fullName: 'Ada Okafor' })

    expect(result?.data).toEqual({ error: FALLBACK_MESSAGE })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('rejects a phone number that is not one', async () => {
    const { profileUpdate } = fake()
    const result = await updateProfile({ fullName: 'Ada Okafor', phone: 'call me' })
    expect(result?.validationErrors).toMatchObject({
      phone: { _errors: [expect.stringMatching(/Enter a phone number/)] },
    })
    expect(profileUpdate).not.toHaveBeenCalled()
  })
})

describe('turning two-factor on', () => {
  it('refuses when it is already on', async () => {
    const { client } = fake()
    client.auth.mfa.listFactors.mockResolvedValueOnce({
      data: { all: [{ id: 'f1', status: 'verified' }], totp: [{ id: 'f1', status: 'verified' }] },
    } as never)

    const result = await startTotpEnrollment()

    expect(result?.data).toEqual({ error: expect.stringMatching(/already on/) })
    expect(client.auth.mfa.enroll).not.toHaveBeenCalled()
  })

  it('names the app and the issuer on the new factor', async () => {
    const { client } = fake()
    client.auth.mfa.listFactors.mockResolvedValueOnce({ data: null } as never)
    await startTotpEnrollment()
    expect(client.auth.mfa.unenroll).not.toHaveBeenCalled()
    expect(client.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: 'Authenticator app',
      issuer: expect.any(String),
    })
  })

  it('explains a refused enrolment', async () => {
    const { client } = fake()
    client.auth.mfa.enroll.mockResolvedValueOnce({
      data: null,
      error: { code: 'too_many_enrolled_mfa_factors' },
    } as never)
    expect((await startTotpEnrollment())?.data).toEqual({
      error: expect.stringMatching(/maximum number of authenticator apps/),
    })
  })

  it('falls back to a general failure when Supabase returns nothing at all', async () => {
    const { client } = fake()
    client.auth.mfa.enroll.mockResolvedValueOnce({ data: null, error: null } as never)
    expect((await startTotpEnrollment())?.data).toEqual({ error: FALLBACK_MESSAGE })
  })

  it('treats a session with no recorded sign-in method as not started with the password', async () => {
    const { client } = fake()
    // authAction asks too (finished sign-in?), then the action itself.
    client.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: null } as never)
    const result = await startTotpEnrollment()
    expect(result?.data).toEqual({ error: expect.stringMatching(/Sign in with your password/) })
  })
})

describe('confirmTotpEnrollment', () => {
  it('turns two-factor on once the first code checks out', async () => {
    const { client } = fake()
    const result = await confirmTotpEnrollment({ factorId: 'factor-1', code: '123 456' })

    expect(result?.data).toEqual({ ok: true })
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'factor-1',
      code: '123456',
    })
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'two_factor_on')
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings')
  })

  it('explains a wrong code and leaves two-factor off', async () => {
    const { client } = fake()
    client.auth.mfa.challengeAndVerify.mockResolvedValueOnce({
      data: {},
      error: { code: 'mfa_verification_failed' },
    } as never)

    const result = await confirmTotpEnrollment({ factorId: 'factor-1', code: '000000' })

    expect(result?.data).toEqual({ error: expect.stringMatching(/Codes change every 30 seconds/) })
    expect(queueAccountNotice).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('rejects something that is not a 6-digit code before asking Supabase', async () => {
    const { client } = fake()
    const result = await confirmTotpEnrollment({ factorId: 'factor-1', code: '12ab' })
    expect(result?.validationErrors).toMatchObject({
      code: { _errors: ['Enter the 6-digit code from your app'] },
    })
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled()
  })
})

describe('turning two-factor off', () => {
  const fresh = () => [
    { method: 'totp', timestamp: now() },
    { method: 'password', timestamp: now() },
  ]

  it('removes the factor after a fresh code, then refreshes Settings', async () => {
    const { client } = fake({ currentLevel: 'aal2', methods: fresh() })

    const result = await disableTwoFactor({ factorId: 'factor-1' })

    expect(result?.data).toEqual({ ok: true })
    expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'factor-1' })
    expect(queueAccountNotice).toHaveBeenCalledWith('user-1', 'two_factor_off')
    expect(revalidatePath).toHaveBeenCalledWith('/app/settings')
  })

  it('is held during the 24 hours after a password reset, even with a fresh code', async () => {
    const { client } = fake({
      currentLevel: 'aal2',
      methods: fresh(),
      passwordResetAt: new Date().toISOString(),
    })

    const result = await disableTwoFactor({ factorId: 'factor-1' })

    expect(result?.data).toEqual({ error: expect.stringMatching(/paused for 24 hours/) })
    expect(client.auth.mfa.unenroll).not.toHaveBeenCalled()
  })

  it('explains when Supabase refuses to remove the factor', async () => {
    const { client } = fake({ currentLevel: 'aal2', methods: fresh() })
    client.auth.mfa.unenroll.mockResolvedValueOnce({
      data: {},
      error: { code: 'session_not_found' },
    } as never)

    const result = await disableTwoFactor({ factorId: 'factor-1' })

    expect(result?.data).toEqual({ error: expect.stringMatching(/session has ended/) })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('asks for a code when the session carries no sign-in methods at all', async () => {
    const { client } = fake()
    client.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValueOnce({ data: null } as never)
    expect((await disableTwoFactor({ factorId: 'factor-1' }))?.data).toEqual({ verify: true })
  })
})

describe('verifySecondFactor', () => {
  function withVerifiedFactor() {
    const faked = fake()
    faked.client.auth.mfa.listFactors.mockResolvedValue({
      data: {
        all: [{ id: 'factor-1', status: 'verified' }],
        totp: [{ id: 'factor-1', status: 'verified' }],
      },
    } as never)
    return faked
  }

  it('continues where the person was headed once the code checks out', async () => {
    const { client } = withVerifiedFactor()

    const target = await redirectTarget(
      verifySecondFactor({ code: '123 456', next: '/app/settings#two-factor' }),
    )

    expect(target).toBe('/app/settings#two-factor')
    expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'factor-1',
      code: '123456',
    })
  })

  it('never continues off-site after verifying', async () => {
    withVerifiedFactor()
    expect(
      await redirectTarget(verifySecondFactor({ code: '123456', next: 'https://evil.example' })),
    ).toBe('/app/domains')
  })

  it('keeps the person on the page with an explanation when the code is wrong', async () => {
    const { client } = withVerifiedFactor()
    client.auth.mfa.challengeAndVerify.mockResolvedValueOnce({
      data: {},
      error: { code: 'mfa_challenge_expired' },
    } as never)

    const result = await verifySecondFactor({ code: '123456' })

    expect(result?.data).toEqual({ error: expect.stringMatching(/That code expired/) })
  })

  it('lets an account without two-factor straight through', async () => {
    const { client } = fake()
    expect(await redirectTarget(verifySecondFactor({ code: '123456', next: '/cart' }))).toBe(
      '/cart',
    )
    expect(client.auth.mfa.challengeAndVerify).not.toHaveBeenCalled()
  })
})
