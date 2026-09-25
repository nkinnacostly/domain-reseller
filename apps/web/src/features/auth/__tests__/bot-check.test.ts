import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '102.89.1.2', 'user-agent': 'Chrome' }),
}))
vi.mock('../queries/notices', () => ({ noteSignIn: vi.fn(), queueAccountNotice: vi.fn() }))

const REFUSED = "We couldn't confirm you're a person. Try again."

/** env.ts reads process.env once, at import — so each case loads the actions fresh. */
async function load(turnstile = true) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', turnstile ? 'site-key' : undefined)
  vi.stubEnv('TURNSTILE_SECRET_KEY', turnstile ? 'secret-key' : undefined)
  const ok = async () => ({ data: { user: null }, error: null })
  const auth = {
    signUp: vi.fn(ok),
    resend: vi.fn(ok),
    signInWithOtp: vi.fn(ok),
    resetPasswordForEmail: vi.fn(ok),
    signInWithPassword: vi.fn(ok),
    mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: null })) },
  }
  const { createClient } = await import('@/lib/supabase/server')
  vi.mocked(createClient).mockResolvedValue({ auth } as never)
  return { ...(await import('../actions/session')), auth }
}

/** What Cloudflare was asked, answering as told. */
function cloudflareSays(answer: () => Response) {
  const sent: URLSearchParams[] = []
  server.use(
    http.post(SITEVERIFY, async ({ request }) => {
      sent.push(new URLSearchParams(await request.text()))
      return answer()
    }),
  )
  return sent
}

const person = () => HttpResponse.json({ success: true })

const SIGN_UP = { fullName: 'Ada Okafor', email: 'ada@example.com', password: 'long-enough-1' }

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('forms that send email ask Turnstile first — refusals first (SEC-9)', () => {
  it('refuses a sign-up without a token, and never asks Supabase', async () => {
    const { signUp, auth } = await load()
    const sent = cloudflareSays(person)

    expect((await signUp(SIGN_UP))?.data).toEqual({ error: REFUSED })
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('refuses a sign-up whose token Cloudflare turns down', async () => {
    const { signUp, auth } = await load()
    cloudflareSays(() =>
      HttpResponse.json({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    )

    expect((await signUp({ ...SIGN_UP, turnstileToken: 'spent' }))?.data).toEqual({
      error: REFUSED,
    })
    expect(auth.signUp).not.toHaveBeenCalled()
  })

  it('refuses when Cloudflare cannot be asked — fails closed, and says to try again', async () => {
    const { signUp, auth } = await load()
    cloudflareSays(() => HttpResponse.error())

    expect((await signUp({ ...SIGN_UP, turnstileToken: 'token' }))?.data).toEqual({
      error: expect.stringMatching(/Try again in a moment\.$/),
    })
    expect(auth.signUp).not.toHaveBeenCalled()
  })

  it.each([
    ['a sign-in link', 'sendMagicLink', 'signInWithOtp'],
    ['a password reset', 'requestPasswordReset', 'resetPasswordForEmail'],
    ['the confirmation again', 'resendConfirmation', 'resend'],
  ] as const)(
    'refuses %s without a token, and never asks Supabase',
    async (_case, action, call) => {
      const loaded = await load()

      expect((await loaded[action]({ email: 'ada@example.com' }))?.data).toEqual({ error: REFUSED })
      expect(loaded.auth[call]).not.toHaveBeenCalled()
    },
  )

  it('refuses a token longer than any Cloudflare issues, as invalid input', async () => {
    const { signUp, auth } = await load()
    const result = await signUp({ ...SIGN_UP, turnstileToken: 'x'.repeat(2049) })
    expect(result?.validationErrors).toBeDefined()
    expect(auth.signUp).not.toHaveBeenCalled()
  })
})

describe('forms that send email ask Turnstile first (SEC-9)', () => {
  it('signs up a person, sending Cloudflare the token and their address first', async () => {
    const { signUp, auth } = await load()
    const sent = cloudflareSays(person)

    expect((await signUp({ ...SIGN_UP, turnstileToken: 'good' }))?.data).toEqual({
      sentTo: 'ada@example.com',
    })
    expect(sent[0]?.get('response')).toBe('good')
    expect(sent[0]?.get('remoteip')).toBe('102.89.1.2')
    expect(auth.signUp).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a sign-in link', 'sendMagicLink', 'signInWithOtp'],
    ['a password reset', 'requestPasswordReset', 'resetPasswordForEmail'],
    ['the confirmation again', 'resendConfirmation', 'resend'],
  ] as const)('sends %s once the check passes', async (_case, action, call) => {
    const loaded = await load()
    cloudflareSays(person)

    const result = await loaded[action]({ email: 'ada@example.com', turnstileToken: 'good' })

    expect(result?.data).toEqual({ sentTo: 'ada@example.com' })
    expect(loaded.auth[call]).toHaveBeenCalledTimes(1)
  })

  it('never asks about a password sign-in: it sends no email', async () => {
    const { signIn, auth } = await load()
    const sent = cloudflareSays(person)

    await signIn({ email: 'ada@example.com', password: 'whatever' }).catch(() => undefined)

    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(0)
  })

  it('with Turnstile off, works exactly as before', async () => {
    const { signUp, auth } = await load(false)
    const sent = cloudflareSays(person)

    expect((await signUp(SIGN_UP))?.data).toEqual({ sentTo: 'ada@example.com' })
    expect(auth.signUp).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(0)
  })
})
