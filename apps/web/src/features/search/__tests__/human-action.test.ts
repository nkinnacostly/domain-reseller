import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** The request being served, and the cookies the action set on its answer. */
const request = vi.hoisted(() => ({
  headers: new Headers(),
  set: [] as { name: string; value: string; options: Record<string, unknown> }[],
}))

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: Record<string, unknown>) =>
      request.set.push({ name, value, options }),
  }),
}))

const SECRET = 'sb_secret_test_only'
/** A variable left unset. (Named, so the pre-commit secret scan does not read it as a key.) */
const unset = undefined
const KEYS = {
  SUPABASE_SECRET_KEY: SECRET,
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site-key',
  TURNSTILE_SECRET_KEY: 'secret-key',
}

/** env.ts reads process.env once, at import — so each case loads the modules fresh. */
async function load(vars: Record<string, string | undefined> = KEYS) {
  vi.resetModules()
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value)
  const { confirmHuman } = await import('../actions/human')
  const { clientKey } = await import('@/lib/client-ip')
  const { isValidHumanPass } = await import('../lib/human-pass')
  return { confirmHuman, clientKey, isValidHumanPass }
}

function cloudflareSays(answer: () => Response) {
  let asked = 0
  server.use(
    http.post(SITEVERIFY, () => {
      asked += 1
      return answer()
    }),
  )
  return () => asked
}

beforeEach(() => {
  request.headers = new Headers({ 'x-real-ip': '102.89.1.2' })
  request.set = []
})
afterEach(() => vi.unstubAllEnvs())

describe('confirmHuman — refusals first (SEC-9)', () => {
  it('sets no pass for a token Cloudflare refuses', async () => {
    const { confirmHuman } = await load()
    cloudflareSays(() =>
      HttpResponse.json({ success: false, 'error-codes': ['invalid-input-response'] }),
    )

    const result = await confirmHuman({ token: 'bad' })

    expect(result?.data).toEqual({ error: "We couldn't confirm you're a person. Try again." })
    expect(request.set).toEqual([])
  })

  it('sets no pass when Cloudflare cannot be asked — it fails closed', async () => {
    const { confirmHuman } = await load()
    cloudflareSays(() => HttpResponse.error())

    const result = await confirmHuman({ token: 'token' })

    expect(result?.data).toEqual({ error: expect.stringMatching(/didn't answer/) })
    expect(request.set).toEqual([])
  })

  it('gives no pass when Turnstile is off: nothing was checked, so nothing is proved', async () => {
    const { confirmHuman } = await load({
      ...KEYS,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined,
      TURNSTILE_SECRET_KEY: undefined,
    })
    const asked = cloudflareSays(() => HttpResponse.json({ success: true }))

    const result = await confirmHuman({ token: 'token' })

    expect(result?.data).toEqual({ error: "We couldn't confirm you're a person. Try again." })
    expect(asked()).toBe(0)
    expect(request.set).toEqual([])
  })

  it('gives no pass without a secret to sign it with', async () => {
    const { confirmHuman } = await load({ ...KEYS, SUPABASE_SECRET_KEY: unset })

    const result = await confirmHuman({ token: 'token' })

    expect(result?.data).toEqual({ error: expect.stringMatching(/didn't answer/) })
    expect(request.set).toEqual([])
  })

  it('refuses an empty or oversized token before asking anyone', async () => {
    const { confirmHuman } = await load()
    const asked = cloudflareSays(() => HttpResponse.json({ success: true }))

    expect((await confirmHuman({ token: '' }))?.validationErrors).toBeDefined()
    expect((await confirmHuman({ token: 'x'.repeat(2049) }))?.validationErrors).toBeDefined()
    expect(asked()).toBe(0)
  })
})

describe('confirmHuman', () => {
  it('sets a signed, httpOnly pass for this connection, for two hours, on /search', async () => {
    const { confirmHuman, clientKey, isValidHumanPass } = await load()
    cloudflareSays(() => HttpResponse.json({ success: true }))

    const result = await confirmHuman({ token: 'good' })

    expect(result?.data).toEqual({ passed: true })
    expect(request.set).toHaveLength(1)
    const [cookie] = request.set
    expect(cookie?.name).toBe('dr_search_pass')
    expect(cookie?.options).toEqual({
      path: '/search',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7_200,
    })
    const now = Math.floor(Date.now() / 1000)
    const me = clientKey(request.headers)
    expect(isValidHumanPass(cookie?.value, SECRET, me, now)).toBe(true)
    expect(isValidHumanPass(cookie?.value, SECRET, 'another-connection', now)).toBe(false)
    expect(cookie?.value).not.toContain('102.89')
  })

  it('marks the pass Secure in production', async () => {
    const { confirmHuman } = await load({ ...KEYS, NODE_ENV: 'production' })
    cloudflareSays(() => HttpResponse.json({ success: true }))

    await confirmHuman({ token: 'good' })

    expect(request.set[0]?.options).toMatchObject({ secure: true, httpOnly: true })
  })
})
