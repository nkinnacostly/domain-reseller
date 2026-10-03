import type { IncomingMessage } from 'node:http'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination'
import { NextRequest, type NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_NOT_FOUND_PATH, STRANGER_HEADER } from '@/features/admin/lib/gate'
import { SIGNED_IN_HINT } from '@/features/auth/lib/signed-in-hint'
import nextConfig, { ADMIN_SOURCES, UNANSWERED } from '../next.config'
import { config, proxy } from './proxy'

/**
 * The proxy's wiring around adminDecision (ADMIN-SPEC §2.3): which answer each
 * admin_status word gets, the headers every /admin answer carries, and the
 * refreshed session cookies copied onto redirects and rewrites. The pure
 * decision is tested in gate.test.ts; Supabase is the network boundary here.
 */

type Cookie = { name: string; value: string; options?: Record<string, unknown> }

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  status: { data: 'not_admin', error: null } as {
    data: unknown
    error: { message: string } | null
  },
  aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
  /** What a token refresh writes during getUser(). */
  refreshed: [] as Cookie[],
  rpc: vi.fn(),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { setAll: (cookies: Cookie[]) => void } },
  ) => ({
    auth: {
      getUser: async () => {
        if (auth.refreshed.length > 0) options.cookies.setAll(auth.refreshed)
        return { data: { user: auth.user } }
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: auth.aal }) },
    },
    rpc: auth.rpc,
  }),
}))

const SITE = 'https://www.mydomainshub.com'
const request = (path: string, cookie?: string) =>
  new NextRequest(`${SITE}${path}`, cookie ? { headers: { cookie } } : {})

const scriptSrc = (csp: string | null) =>
  (csp ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src ')) ?? ''

const nonceOf = (response: NextResponse) =>
  /'nonce-([^']+)'/.exec(scriptSrc(response.headers.get('content-security-policy')))?.[1]

/** The headers §2.3 puts on every /admin answer, whatever the answer is. */
function expectAdminHeaders(response: NextResponse) {
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  const script = scriptSrc(response.headers.get('content-security-policy'))
  expect(script).toMatch(/'nonce-[A-Za-z0-9+/=]{16,}'/)
  expect(script).toContain("'strict-dynamic'")
  expect(script).not.toContain("'unsafe-inline'")
}

/** The site-wide CSP next.config.ts gives every page but /admin. */
async function siteCspFromConfig(): Promise<string | undefined> {
  const rules = (await nextConfig.headers?.()) ?? []
  return rules
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === 'content-security-policy')?.value
}

/**
 * A stranger at /admin (D9): passed on marked, for next.config.ts's rewrite
 * to Next's own 404 — never the proxy's rewrite, whose x-middleware-rewrite
 * header no other 404 carries — with what any other 404 carries: the site's
 * CSP, no nonce, nothing from the admin headers, and no nonce sent on to Next.
 */
async function expectStranger(response: NextResponse) {
  expect(response.headers.get('x-middleware-next')).toBe('1')
  expect(response.headers.get('x-middleware-rewrite')).toBeNull()
  expect(response.headers.get(`x-middleware-request-${STRANGER_HEADER}`)).toBe('1')
  expect(response.headers.get('content-security-policy')).toBe(await siteCspFromConfig())
  expect(scriptSrc(response.headers.get('content-security-policy'))).not.toMatch(/'nonce-/)
  expect(response.headers.get('x-robots-tag')).toBeNull()
  expect(response.headers.get('cache-control')).toBeNull()
  expect(response.headers.get('x-middleware-request-content-security-policy')).toBeNull()
}

/** Next's own matcher for a config `source`, as its router builds it. */
const sourceMatch = (source: string, path: string) =>
  getPathMatch(source, { strict: true, removeUnnamedParams: true })(path)

/**
 * The headers Next's router sends for `path`, name and value in order, put
 * together as resolve-routes does: the config's header rules in order, then
 * the proxy's own headers (a name the config already set keeps its place),
 * then a rewrite — beforeFiles, judged on the request headers the proxy
 * passed on, or the fallback when no page answers — which tells an RSC
 * request its rewritten path before anything else. `date` and `set-cookie`
 * are left out, as they differ between any two answers.
 */
async function routed(
  path: string,
  asked: Record<string, string>,
  { pageAnswers }: { pageAnswers: boolean },
): Promise<string[]> {
  const headers: Record<string, string> = {}
  for (const rule of (await nextConfig.headers?.()) ?? []) {
    if (!sourceMatch(rule.source, path)) continue
    for (const { key, value } of rule.headers) headers[key] = value
  }

  const response = await proxy(new NextRequest(`${SITE}${path}`, { headers: asked }))
  const overridden = response.headers.get('x-middleware-override-headers')
  const passedOn: Record<string, string> = overridden
    ? Object.fromEntries(
        overridden
          .split(',')
          .map((name) => [name, response.headers.get(`x-middleware-request-${name}`) ?? '']),
      )
    : { ...asked }
  for (const [name, value] of response.headers) {
    if (name.startsWith('x-middleware-') || name === 'set-cookie') continue
    headers[name] = value
  }

  const rewrites = await nextConfig.rewrites?.()
  const { beforeFiles = [], fallback = [] } = rewrites && !Array.isArray(rewrites) ? rewrites : {}
  const request = { headers: passedOn } as unknown as IncomingMessage
  const before = beforeFiles.find(
    (rule) => sourceMatch(rule.source, path) && matchHas(request, {}, rule.has, rule.missing),
  )
  const after = pageAnswers ? undefined : fallback.find((rule) => sourceMatch(rule.source, path))
  const destination = (before ?? after)?.destination
  const first =
    asked.rsc === '1' && destination && destination !== path
      ? [`x-nextjs-rewritten-path: ${destination}`]
      : []
  return [...first, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)]
}

/** A document, and the requests Next's client router sends for a page. */
const ASKED_AS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['a document', {}],
  ['a client navigation (rsc: 1)', { rsc: '1' }],
  ['a prefetch', { rsc: '1', 'next-router-prefetch': '1' }],
  [
    'a segment prefetch',
    { rsc: '1', 'next-router-prefetch': '1', 'next-router-segment-prefetch': '/_tree' },
  ],
]

const rewrittenTo = (response: NextResponse) => {
  const target = response.headers.get('x-middleware-rewrite')
  return target ? new URL(target).pathname : null
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.user = null
  auth.status = { data: 'not_admin', error: null }
  auth.aal = { currentLevel: 'aal1', nextLevel: 'aal1' }
  auth.refreshed = []
  auth.rpc.mockImplementation(async (name: string) =>
    name === 'admin_status' ? auth.status : { data: null, error: { message: 'no such function' } },
  )
})

describe('the proxy at /admin', () => {
  it("marks a signed-out visitor for the 404, under the site's own headers, without asking SQL", async () => {
    const response = await proxy(request('/admin/refunds'))
    await expectStranger(response)
    expect(auth.rpc).not.toHaveBeenCalled()
  })

  it('sends a marked /admin request, and any path no page answers, to a path no page answers', async () => {
    const rewrites = await nextConfig.rewrites?.()
    const { beforeFiles, fallback } =
      rewrites && !Array.isArray(rewrites) ? rewrites : { beforeFiles: [], fallback: [] }
    expect(beforeFiles).toEqual([
      {
        source: '/admin',
        has: [{ type: 'header', key: STRANGER_HEADER, value: '1' }],
        destination: ADMIN_NOT_FOUND_PATH,
      },
      {
        source: '/admin/(.*)',
        has: [{ type: 'header', key: STRANGER_HEADER, value: '1' }],
        destination: ADMIN_NOT_FOUND_PATH,
      },
    ])
    expect(fallback).toEqual([{ source: UNANSWERED, destination: ADMIN_NOT_FOUND_PATH }])
    expect(ADMIN_NOT_FOUND_PATH).not.toMatch(/admin/)
  })

  it("captures nothing into the 404's query, at /admin or anywhere else", () => {
    // `/admin/:path*` put `?path=refunds` in the payload, which a random path's lacks.
    for (const path of ['/admin', '/admin/refunds', '/admin/orders/x.png']) {
      const matched = ADMIN_SOURCES.map((source) => sourceMatch(source, path)).find(Boolean)
      expect(matched, path).toEqual({})
    }
    for (const path of ['/no-such-page', '/a/b/c', '/admin']) {
      expect(sourceMatch(UNANSWERED, path), path).toEqual({})
    }
    expect(sourceMatch(UNANSWERED, '/_next/static/chunks/gone.js')).toBe(false)
  })

  it.each([
    ['not_admin', { data: 'not_admin', error: null }],
    ['an error', { data: null, error: { message: 'function admin_status does not exist' } }],
    ['a word it does not know', { data: 'owner', error: null }],
  ])('marks a signed-in person SQL answers with %s for the same 404', async (_, status) => {
    auth.user = { id: 'u1' }
    auth.status = status
    const response = await proxy(request('/admin'))
    expect(auth.rpc).toHaveBeenCalledWith('admin_status')
    await expectStranger(response)
  })

  it('sends an admin whose code is missing or stale to /verify, with the path and query as next', async () => {
    auth.user = { id: 'u1' }
    auth.status = { data: 'needs_code', error: null }
    const response = await proxy(request('/admin/audit?label=owner&page=2'))
    expect(response.status).toBe(307)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/verify')
    expect(location.searchParams.get('next')).toBe('/admin/audit?label=owner&page=2')
    expectAdminHeaders(response)
  })

  it.each(['ok', 'factor_mismatch', 'weak_sign_in'])(
    'lets %s through to the layout, with the nonce on the request so Next stamps its scripts',
    async (word) => {
      auth.user = { id: 'u1' }
      auth.status = { data: word, error: null }
      const response = await proxy(request('/admin'))
      expect(response.headers.get('x-middleware-next')).toBe('1')
      expect(rewrittenTo(response)).toBeNull()
      expect(response.headers.get(`x-middleware-request-${STRANGER_HEADER}`)).toBeNull()
      expectAdminHeaders(response)
      expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(
        response.headers.get('content-security-policy'),
      )
    },
  )

  it("gives every admin's answer a fresh nonce", async () => {
    auth.user = { id: 'u1' }
    auth.status = { data: 'ok', error: null }
    const first = await proxy(request('/admin'))
    const second = await proxy(request('/admin'))
    expect(nonceOf(first)).toBeDefined()
    expect(nonceOf(first)).not.toBe(nonceOf(second))
  })

  it('copies a refreshed session onto a redirect and a rewrite, httpOnly, with the signed-in hint', async () => {
    auth.user = { id: 'u1' }
    auth.refreshed = [
      { name: 'sb-test-auth-token', value: 'fresh', options: { httpOnly: true, path: '/' } },
    ]
    for (const word of ['needs_code', 'not_admin']) {
      auth.status = { data: word, error: null }
      const response = await proxy(request('/admin'))
      expect(response.cookies.get('sb-test-auth-token')).toMatchObject({
        value: 'fresh',
        httpOnly: true,
      })
      expect(response.cookies.get(SIGNED_IN_HINT)?.value).toBe('1')
    }
  })

  it('drops a stale signed-in hint when nobody is signed in', async () => {
    const response = await proxy(request('/admin', `${SIGNED_IN_HINT}=1`))
    expect(response.cookies.get(SIGNED_IN_HINT)?.value).toBe('')
  })

  it('matches every /admin path on its own, image-named ones included', async () => {
    expect(config.matcher).toEqual(expect.arrayContaining(['/admin', '/admin/:path*']))
    await expectStranger(await proxy(request('/admin/orders/x.png')))
  })

  it("drops a mark the browser sent itself, so an admin's pages still render", async () => {
    auth.user = { id: 'u1' }
    auth.status = { data: 'ok', error: null }
    const forged = new NextRequest(`${SITE}/admin`, { headers: { [STRANGER_HEADER]: '1' } })
    const response = await proxy(forged)
    expect(response.headers.get('x-middleware-next')).toBe('1')
    // Listed for the request without the mark: Next deletes it before the rewrite is judged.
    const kept = (response.headers.get('x-middleware-override-headers') ?? '').split(',')
    expect(kept).toContain('content-security-policy')
    expect(kept).not.toContain(STRANGER_HEADER)
    expect(response.headers.get(`x-middleware-request-${STRANGER_HEADER}`)).toBeNull()
  })
})

describe("a stranger's 404 at /admin beside any other 404, as Next sends them (D9)", () => {
  it.each(ASKED_AS)(
    'carries the same headers, named and valued alike, in the same order, asked as %s',
    async (_, asked) => {
      for (const user of [null, { id: 'u1' }]) {
        auth.user = user
        const elsewhere = await routed('/no-such-page', asked, { pageAnswers: false })
        for (const path of ['/admin', '/admin/refunds', '/admin/orders/x.png']) {
          expect(await routed(path, asked, { pageAnswers: true }), path).toEqual(elsewhere)
        }
      }
    },
  )

  it("tells an RSC request any 404's rewritten path, and a document nothing", async () => {
    const rsc = await routed('/no-such-page', { rsc: '1' }, { pageAnswers: false })
    expect(rsc[0]).toBe(`x-nextjs-rewritten-path: ${ADMIN_NOT_FOUND_PATH}`)
    const doc = await routed('/no-such-page', {}, { pageAnswers: false })
    expect(doc.some((line) => line.startsWith('x-nextjs-rewritten-path'))).toBe(false)
  })

  it('puts the CSP after the security headers on both, as Next writes them', async () => {
    for (const [path, pageAnswers] of [
      ['/admin', true],
      ['/no-such-page', false],
    ] as const) {
      const names = (await routed(path, {}, { pageAnswers })).map((line) => line.split(':')[0])
      expect(names, path).toEqual([
        'X-Content-Type-Options',
        'X-Frame-Options',
        'Referrer-Policy',
        'Permissions-Policy',
        'Strict-Transport-Security',
        'content-security-policy',
      ])
    }
  })
})

describe('the proxy elsewhere', () => {
  it('leaves the rest of the site to its own policy: no nonce, no admin headers', async () => {
    const response = await proxy(request('/pricing'))
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(response.headers.get('x-robots-tag')).toBeNull()
    expect(auth.rpc).not.toHaveBeenCalled()
  })

  it("follows next to /admin from /sign-in for someone signed in, and nowhere else's (D9)", async () => {
    auth.user = { id: 'u1' }
    const signIn = await proxy(request('/sign-in?next=/admin/refunds'))
    expect(new URL(signIn.headers.get('location') ?? '').pathname).toBe('/admin/refunds')
    const signUp = await proxy(request('/sign-up?next=/admin/refunds'))
    expect(new URL(signUp.headers.get('location') ?? '').pathname).toBe('/app/domains')
  })

  it('sends a signed-out visitor of the panel to sign in, and a half-signed-in one to the code', async () => {
    const out = await proxy(request('/app/domains?tab=all'))
    const location = new URL(out.headers.get('location') ?? '')
    expect(location.pathname).toBe('/sign-in')
    expect(location.searchParams.get('next')).toBe('/app/domains?tab=all')

    auth.user = { id: 'u1' }
    auth.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }
    const half = await proxy(request('/app/domains'))
    expect(new URL(half.headers.get('location') ?? '').pathname).toBe('/verify')
  })
})
