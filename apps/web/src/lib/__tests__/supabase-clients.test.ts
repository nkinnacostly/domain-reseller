import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Supabase factories are thin, but each one decides which key a client
 * carries and whether it holds a session — the difference between RLS
 * applying and not (N6). The libraries are the boundary, so they are mocked.
 */
const lib = vi.hoisted(() => ({
  createBrowserClient: vi.fn(() => ({ kind: 'browser' })),
  createServerClient: vi.fn(() => ({ kind: 'server' })),
  createClient: vi.fn(() => ({ kind: 'plain' })),
  cookies: vi.fn(),
  headers: vi.fn(async () => new Headers()),
}))

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: lib.createBrowserClient,
  createServerClient: lib.createServerClient,
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: lib.createClient }))
vi.mock('next/headers', () => ({ cookies: lib.cookies, headers: lib.headers }))

// From the test setup: the local Supabase URL and its publishable key.
const PROJECT_URL = 'http://127.0.0.1:54321'
const PUBLISHABLE = 'test-anon-key'
const SECRET = 'sb_secret_test_only_dummy'
const NO_SESSION = { auth: { autoRefreshToken: false, persistSession: false } }

/** env.ts reads process.env once, at import — so each case loads it fresh. */
function withSecretKey(value: string | undefined) {
  vi.resetModules()
  vi.stubEnv('SUPABASE_SECRET_KEY', value)
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('browser client', () => {
  it('carries the publishable key only, so every read goes through RLS', async () => {
    const { createClient } = await import('../supabase/client')

    expect(createClient()).toEqual({ kind: 'browser' })
    expect(lib.createBrowserClient).toHaveBeenCalledWith(PROJECT_URL, PUBLISHABLE)
  })
})

describe('public client', () => {
  it('carries the publishable key and holds no session, so pages using it stay cacheable', async () => {
    const { createPublicClient } = await import('../supabase/public')

    expect(createPublicClient()).toEqual({ kind: 'plain' })
    expect(lib.createClient).toHaveBeenCalledWith(PROJECT_URL, PUBLISHABLE, NO_SESSION)
  })
})

describe('service client', () => {
  it('refuses to start without the secret key rather than falling back to another', async () => {
    withSecretKey(undefined)
    const { createServiceClient } = await import('../supabase/service')

    expect(() => createServiceClient()).toThrow('SUPABASE_SECRET_KEY is not set')
    expect(lib.createClient).not.toHaveBeenCalled()
  })

  it('carries the secret key and holds no session', async () => {
    withSecretKey(SECRET)
    const { createServiceClient } = await import('../supabase/service')

    createServiceClient()
    expect(lib.createClient).toHaveBeenCalledWith(PROJECT_URL, SECRET, NO_SESSION)
  })
})

describe('admin client', () => {
  it('refuses to start without the secret key', async () => {
    withSecretKey(undefined)
    const { createAdminClient } = await import('../supabase/admin')

    expect(() => createAdminClient()).toThrow(/admin client cannot be created/)
    expect(lib.createClient).not.toHaveBeenCalled()
  })

  it('carries the secret key and holds no session', async () => {
    withSecretKey(SECRET)
    const { createAdminClient } = await import('../supabase/admin')

    createAdminClient()
    expect(lib.createClient).toHaveBeenCalledWith(PROJECT_URL, SECRET, NO_SESSION)
  })
})

describe('server client', () => {
  type CookieAdapter = {
    getAll: () => unknown
    setAll: (cookies: { name: string; value: string; options: object }[]) => void
  }

  /** The cookie adapter the server client was built with. */
  async function build(store: { getAll: () => unknown; set: (...args: unknown[]) => void }) {
    lib.cookies.mockResolvedValue(store)
    const { createClient } = await import('../supabase/server')
    const client = await createClient()
    const [url, key, options] = lib.createServerClient.mock.calls[0] as unknown as [
      string,
      string,
      { cookies: CookieAdapter },
    ]
    return { client, url, key, cookies: options.cookies }
  }

  it("acts as the user: publishable key, with the request's cookies", async () => {
    const store = { getAll: () => [{ name: 'sb-access-token', value: 'abc' }], set: vi.fn() }
    const { client, url, key, cookies } = await build(store)

    expect(client).toEqual({ kind: 'server' })
    expect([url, key]).toEqual([PROJECT_URL, PUBLISHABLE])
    expect(cookies.getAll()).toEqual([{ name: 'sb-access-token', value: 'abc' }])
  })

  it("passes on the person's browser and address, so their sessions record them (FR-A5)", async () => {
    lib.headers.mockResolvedValueOnce(
      new Headers({ 'user-agent': 'Mozilla/5.0 Chrome/140.0', 'x-real-ip': '102.89.1.2' }),
    )
    await build({ getAll: () => [], set: vi.fn() })
    const [, , options] = lib.createServerClient.mock.calls[0] as unknown as [
      string,
      string,
      { global: { headers: Record<string, string> } },
    ]

    expect(options.global.headers).toEqual({
      'user-agent': 'Mozilla/5.0 Chrome/140.0',
      'x-forwarded-for': '102.89.1.2',
    })
  })

  it('writes every refreshed session cookie back, with its options', async () => {
    const store = { getAll: () => [], set: vi.fn() }
    const { cookies } = await build(store)

    cookies.setAll([
      { name: 'sb-access-token', value: 'new', options: { httpOnly: true } },
      { name: 'sb-refresh-token', value: 'r', options: { path: '/' } },
    ])

    expect(store.set).toHaveBeenNthCalledWith(1, 'sb-access-token', 'new', { httpOnly: true })
    expect(store.set).toHaveBeenNthCalledWith(2, 'sb-refresh-token', 'r', { path: '/' })
  })

  it('writes session cookies httpOnly, so no script can lift the refresh token (ADMIN-SPEC §5.1)', async () => {
    await build({ getAll: () => [], set: vi.fn() })
    const [, , options] = lib.createServerClient.mock.calls[0] as unknown as [
      string,
      string,
      { cookieOptions: { httpOnly: boolean } },
    ]
    expect(options.cookieOptions).toEqual({ httpOnly: true })
  })

  it('passes a request id on as x-request-id, and nothing that is not a uuid', async () => {
    lib.cookies.mockResolvedValue({ getAll: () => [], set: vi.fn() })
    const { createClient } = await import('../supabase/server')
    await createClient({ requestId: '8dbd7ea2-c535-4a4a-a091-e202d9185a20' })
    await createClient({ requestId: 'not-a-uuid\r\nx-evil: 1' })
    const headersOf = (call: number) =>
      (
        lib.createServerClient.mock.calls[call] as unknown as [
          string,
          string,
          { global: { headers: Record<string, string> } },
        ]
      )[2].global.headers
    expect(headersOf(0)['x-request-id']).toBe('8dbd7ea2-c535-4a4a-a091-e202d9185a20')
    expect(headersOf(1)['x-request-id']).toBeUndefined()
  })

  it('ignores a refresh from a Server Component, where cookies cannot be written', async () => {
    const store = {
      getAll: () => [],
      set: vi.fn(() => {
        throw new Error('Cookies can only be modified in a Server Action or Route Handler.')
      }),
    }
    const { cookies } = await build(store)

    expect(() =>
      cookies.setAll([{ name: 'sb-access-token', value: 'new', options: {} }]),
    ).not.toThrow()
  })
})
