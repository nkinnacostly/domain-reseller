import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../tests/mocks/server'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TOKEN = '0.secret-looking-token-from-the-widget'

const KEYS = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' }

/** env.ts and the once-only log are read at import, so each case loads them fresh. */
async function load(vars: Record<string, string | undefined> = KEYS) {
  vi.resetModules()
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value)
  const { logger } = await import('../logger')
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
  return { ...(await import('../turnstile')), error }
}

/** What Cloudflare was sent, and a way to answer. */
function cloudflare(answer: () => Response | Promise<Response>) {
  const sent: URLSearchParams[] = []
  server.use(
    http.post(SITEVERIFY, async ({ request }) => {
      sent.push(new URLSearchParams(await request.text()))
      return answer()
    }),
  )
  return sent
}

const headers = (init: Record<string, string> = { 'x-real-ip': '102.89.1.2' }) => new Headers(init)

/** No log line may carry the token: until it is spent, it is a pass. */
function expectTokenNeverLogged(error: { mock: { calls: unknown[][] } }) {
  expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN)
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('verifyTurnstile — refusals first (SEC-9)', () => {
  it('refuses a missing token without asking Cloudflare, as a check not yet finished', async () => {
    const { verifyTurnstile } = await load()
    const sent = cloudflare(() => HttpResponse.json({ success: true }))

    expect(await verifyTurnstile(undefined, headers())).toEqual({ ok: false, reason: 'missing' })
    expect(await verifyTurnstile('', headers())).toEqual({ ok: false, reason: 'missing' })
    expect(sent).toHaveLength(0)
  })

  it('refuses a token longer than Cloudflare issues, without asking', async () => {
    const { verifyTurnstile, MAX_TOKEN_LENGTH } = await load()
    const sent = cloudflare(() => HttpResponse.json({ success: true }))

    expect(await verifyTurnstile('x'.repeat(MAX_TOKEN_LENGTH + 1), headers())).toEqual({
      ok: false,
      reason: 'refused',
    })
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['a bad token', ['invalid-input-response']],
    ['an expired or reused token', ['timeout-or-duplicate']],
    ['no reason at all', []],
  ])('refuses %s', async (_case, codes) => {
    const { verifyTurnstile, error } = await load()
    cloudflare(() => HttpResponse.json({ success: false, 'error-codes': codes }))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'refused' })
    expectTokenNeverLogged(error)
  })

  it('fails closed when Cloudflare cannot be reached', async () => {
    const { verifyTurnstile, error } = await load()
    cloudflare(() => HttpResponse.error())

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'unanswered' })
    expect(error).toHaveBeenCalledWith(
      { err: 'TypeError' },
      'Turnstile siteverify unreachable; refusing',
    )
    expectTokenNeverLogged(error)
  })

  it('fails closed when Cloudflare answers with an error status', async () => {
    const { verifyTurnstile, error } = await load()
    cloudflare(() => new HttpResponse('upstream trouble', { status: 502 }))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'unanswered' })
    expect(error).toHaveBeenCalledWith({ status: 502 }, 'Turnstile siteverify failed; refusing')
  })

  it('fails closed on an answer that is not JSON', async () => {
    const { verifyTurnstile } = await load()
    cloudflare(() => new HttpResponse('<html>', { headers: { 'content-type': 'text/html' } }))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'unanswered' })
  })

  it('fails closed on an answer with no body worth reading', async () => {
    const { verifyTurnstile } = await load()
    cloudflare(() => HttpResponse.json(null))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'refused' })
  })

  it('gives up after 10 seconds rather than hold the form', async () => {
    const { verifyTurnstile, VERIFY_TIMEOUT_MS } = await load()
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')))
    cloudflare(() => HttpResponse.json({ success: true }))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'unanswered' })
    expect(VERIFY_TIMEOUT_MS).toBe(10_000)
    expect(timeout).toHaveBeenCalledWith(10_000)
  })

  it('treats a secret Cloudflare rejects as ours to fix, and says so in the log', async () => {
    const { verifyTurnstile, error } = await load()
    cloudflare(() => HttpResponse.json({ success: false, 'error-codes': ['invalid-input-secret'] }))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'unanswered' })
    expect(error).toHaveBeenCalledWith(
      { codes: ['invalid-input-secret'] },
      'Turnstile rejected our secret key; refusing',
    )
    expectTokenNeverLogged(error)
  })

  it('treats a Cloudflare internal error as unanswered, to try again', async () => {
    const { verifyTurnstile } = await load()
    cloudflare(() => HttpResponse.json({ success: false, 'error-codes': ['internal-error'] }))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: false, reason: 'unanswered' })
  })
})

describe('verifyTurnstile — a person', () => {
  it('passes a token Cloudflare accepts, sending the secret, the token and the address', async () => {
    const { verifyTurnstile } = await load()
    const sent = cloudflare(() => HttpResponse.json({ success: true, 'error-codes': [] }))

    expect(await verifyTurnstile(TOKEN, headers())).toEqual({ ok: true, skipped: false })
    expect(Object.fromEntries(sent[0] ?? [])).toEqual({
      secret: 'secret-key',
      response: TOKEN,
      remoteip: '102.89.1.2',
    })
  })

  it('takes the address the way per-address limits do, from x-forwarded-for when needed', async () => {
    const { verifyTurnstile } = await load()
    const sent = cloudflare(() => HttpResponse.json({ success: true }))

    await verifyTurnstile(TOKEN, headers({ 'x-forwarded-for': '102.89.1.2, 10.0.0.1' }))
    expect(sent[0]?.get('remoteip')).toBe('102.89.1.2')
  })

  it('sends no address when the platform gave none', async () => {
    const { verifyTurnstile } = await load()
    const sent = cloudflare(() => HttpResponse.json({ success: true }))

    await verifyTurnstile(TOKEN, headers({}))
    expect(sent[0]?.has('remoteip')).toBe(false)
  })
})

describe('Turnstile not configured', () => {
  it.each([
    ['neither key', {}],
    ['only the secret — no widget could send a token', { TURNSTILE_SECRET_KEY: 'secret-key' }],
    ['only the site key', { NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site-key' }],
  ])('with %s, checks nothing and lets the request through', async (_case, keys) => {
    const { verifyTurnstile, isTurnstileEnabled } = await load({
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined,
      TURNSTILE_SECRET_KEY: undefined,
      ...keys,
    })
    const sent = cloudflare(() => HttpResponse.json({ success: false }))

    expect(isTurnstileEnabled()).toBe(false)
    expect(await verifyTurnstile(undefined, headers())).toEqual({ ok: true, skipped: true })
    expect(sent).toHaveLength(0)
  })

  it('says so in the production log, once per process', async () => {
    const { verifyTurnstile, isTurnstileEnabled, error } = await load({
      NODE_ENV: 'production',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined,
      TURNSTILE_SECRET_KEY: undefined,
    })

    isTurnstileEnabled()
    await verifyTurnstile(TOKEN, headers())
    await verifyTurnstile(TOKEN, headers())

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      { hasSiteKey: false, hasSecretKey: false },
      expect.stringContaining('Turnstile is not configured'),
    )
  })

  it('stays quiet about it outside production', async () => {
    const { isTurnstileEnabled, error } = await load({
      NODE_ENV: 'development',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined,
      TURNSTILE_SECRET_KEY: undefined,
    })
    isTurnstileEnabled()
    expect(error).not.toHaveBeenCalled()
  })

  it('is on once both keys are set', async () => {
    const { isTurnstileEnabled } = await load()
    expect(isTurnstileEnabled()).toBe(true)
  })
})

describe('humanCheckError', () => {
  it('asks a refused person to try again, and says when the check did not answer', async () => {
    const { humanCheckError } = await load()
    expect(humanCheckError({ ok: false, reason: 'refused' })).toBe(
      "We couldn't confirm you're a person. Try again.",
    )
    expect(humanCheckError({ ok: false, reason: 'missing' })).toBe(
      'Finish the “Verify you are human” check first: tick its box if you see one, or reload the page if none appears.',
    )
    expect(humanCheckError({ ok: false, reason: 'unanswered' })).toMatch(
      /the check didn't answer\. Try again in a moment\.$/,
    )
  })
})
