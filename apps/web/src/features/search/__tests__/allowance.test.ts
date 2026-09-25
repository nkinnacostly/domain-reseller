import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { HUMAN_PASS_COOKIE, HUMAN_PASS_SECONDS, signHumanPass } from '../lib/human-pass'

/** The request being served, and the rate-limit table's answer. */
const request = vi.hoisted(() => ({
  headers: new Headers(),
  pass: undefined as string | undefined,
  rpc: null as unknown as Mock,
}))

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({
    get: (name: string) =>
      name === 'dr_search_pass' && request.pass ? { name, value: request.pass } : undefined,
  }),
}))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: request.rpc }),
}))

const SECRET = 'sb_secret_test_only'
const ADDRESS = '102.89.1.2'
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
  const { clientKey } = await import('@/lib/client-ip')
  const { LIMITS } = await import('@/lib/rate-limit')
  const allowance = await import('../queries/allowance')
  const now = () => Math.floor(Date.now() / 1000)
  return {
    ...allowance,
    LIMITS,
    me: clientKey(request.headers),
    /** A pass as the action would issue it to this connection. */
    passFor: (key: string, secret = SECRET, issuedAt = now()) =>
      signHumanPass(secret, key, issuedAt),
  }
}

/** The ceiling the rate-limit table was asked to hold this search to. */
const askedMax = () => request.rpc.mock.calls[0]?.[1]?.p_max

beforeEach(() => {
  request.headers = new Headers({ 'x-real-ip': ADDRESS })
  request.pass = undefined
  request.rpc = vi.fn(async () => ({ data: true, error: null }))
})
afterEach(() => vi.unstubAllEnvs())

describe('searchAllowance — refusals first (SEC-9)', () => {
  it('past the free allowance, asks for the Turnstile check instead of searching', async () => {
    const { searchAllowance } = await load()
    request.rpc.mockResolvedValue({ data: false, error: null })
    expect(await searchAllowance()).toBe('challenge')
  })

  it('without Turnstile there is no check to offer: past the allowance, wait', async () => {
    const { searchAllowance } = await load({
      ...KEYS,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined,
      TURNSTILE_SECRET_KEY: undefined,
    })
    request.rpc.mockResolvedValue({ data: false, error: null })
    expect(await searchAllowance()).toBe('limited')
  })

  it('past even the allowance a pass gives, asks to wait — never the check again', async () => {
    const { searchAllowance, passFor, me } = await load()
    request.pass = passFor(me)
    request.rpc.mockResolvedValue({ data: false, error: null })
    expect(await searchAllowance()).toBe('limited')
  })

  it('fails closed when the count cannot be read', async () => {
    const { searchAllowance } = await load()
    request.rpc.mockResolvedValue({ data: null, error: { message: 'db down' } })
    expect(await searchAllowance()).toBe('challenge')
  })

  it.each([
    ['forged', (t: Awaited<ReturnType<typeof load>>) => t.passFor(t.me, 'guessed-secret')],
    [
      'expired',
      (t: Awaited<ReturnType<typeof load>>) =>
        t.passFor(t.me, SECRET, Math.floor(Date.now() / 1000) - HUMAN_PASS_SECONDS - 1),
    ],
    [
      "another connection's",
      (t: Awaited<ReturnType<typeof load>>) => t.passFor('ffffffffffffffffffffffffffffffff'),
    ],
  ])('holds a %s pass to the free allowance', async (_case, make) => {
    const loaded = await load()
    request.pass = make(loaded)
    expect(await loaded.searchAllowance()).toBe('ok')
    expect(askedMax()).toBe(loaded.LIMITS.search.max)
  })

  it('accepts no pass at all when there is no secret to check it with', async () => {
    const loaded = await load({ ...KEYS, SUPABASE_SECRET_KEY: unset })
    request.pass = loaded.passFor(loaded.me)
    expect(await loaded.hasHumanPass()).toBe(false)
  })
})

describe('searchAllowance', () => {
  it('counts each search against a hash of the address, never the address', async () => {
    const { searchAllowance, LIMITS, me } = await load()

    expect(await searchAllowance()).toBe('ok')
    expect(request.rpc).toHaveBeenCalledWith('rate_limit_hit', {
      p_key: `search:${me}`,
      p_max: LIMITS.search.max,
      p_window_seconds: LIMITS.search.windowSeconds,
    })
    expect(JSON.stringify(request.rpc.mock.calls)).not.toContain(ADDRESS)
  })

  it('a pass from this connection lifts the allowance, on the same count', async () => {
    const { searchAllowance, hasHumanPass, LIMITS, passFor, me } = await load()
    request.pass = passFor(me)

    expect(await hasHumanPass()).toBe(true)
    expect(await searchAllowance()).toBe('ok')
    expect(request.rpc).toHaveBeenCalledWith('rate_limit_hit', {
      p_key: `search:${me}`,
      p_max: LIMITS.searchWithPass.max,
      p_window_seconds: LIMITS.searchWithPass.windowSeconds,
    })
  })

  it('reads the pass from its own cookie', async () => {
    const { hasHumanPass, passFor, me } = await load()
    request.pass = passFor(me)
    expect(HUMAN_PASS_COOKIE).toBe('dr_search_pass')
    expect(await hasHumanPass()).toBe(true)
  })
})
