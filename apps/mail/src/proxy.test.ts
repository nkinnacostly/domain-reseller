import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config, matches, proxy } from './proxy'

/**
 * The proxy refreshes the session and keeps the signed-in pages for the
 * signed in. Supabase Auth is the network boundary, mocked as the shop's
 * proxy test does.
 */

type Cookie = { name: string; value: string; options?: Record<string, unknown> }

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  aal: { currentLevel: 'aal1', nextLevel: 'aal1' } as { currentLevel: string; nextLevel: string },
  refreshed: [] as Cookie[],
  headers: null as Record<string, string> | null,
  /** admin_status()'s answer (the shop's gate, migration 40): a word, or an error. */
  adminStatus: { data: 'not_admin', error: null } as { data: unknown; error: unknown },
  rpcCalls: [] as string[],
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: {
      global: { headers: Record<string, string> }
      cookies: { setAll: (cookies: Cookie[]) => void }
    },
  ) => {
    auth.headers = options.global.headers
    return {
      auth: {
        getUser: async () => {
          if (auth.refreshed.length > 0) options.cookies.setAll(auth.refreshed)
          return { data: { user: auth.user } }
        },
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: auth.aal }) },
      },
      rpc: async (fn: string) => {
        auth.rpcCalls.push(fn)
        return auth.adminStatus
      },
    }
  },
}))

const SITE = 'https://emails.mydomainshub.com'
const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`${SITE}${path}`, { headers })
const target = (response: Response) => new URL(response.headers.get('location') ?? '', SITE)

beforeEach(() => {
  auth.user = null
  auth.aal = { currentLevel: 'aal1', nextLevel: 'aal1' }
  auth.refreshed = []
  auth.headers = null
  auth.adminStatus = { data: 'not_admin', error: null }
  auth.rpcCalls = []
})

describe('proxy', () => {
  it('sends a signed-out visitor from the dashboard to sign in, and back after', async () => {
    const response = await proxy(request('/dashboard/keys?tab=all'))
    expect(response.status).toBe(307)
    expect(target(response).pathname).toBe('/sign-in')
    expect(target(response).searchParams.get('next')).toBe('/dashboard/keys?tab=all')
  })

  it('keeps onboarding and the invite page for the signed in, the invite’s link included', async () => {
    expect(target(await proxy(request('/onboarding'))).pathname).toBe('/sign-in')
    const invite = await proxy(request('/invite?token=abc'))
    expect(target(invite).searchParams.get('next')).toBe('/invite?token=abc')
  })

  it('lets a signed-in person through to the dashboard', async () => {
    auth.user = { id: 'u-1' }
    const response = await proxy(request('/dashboard'))
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('asks for the two-factor code before the dashboard when the sign-in has one', async () => {
    auth.user = { id: 'u-1' }
    auth.aal = { currentLevel: 'aal1', nextLevel: 'aal2' }
    const response = await proxy(request('/dashboard/settings'))
    expect(target(response).pathname).toBe('/verify')
    expect(target(response).searchParams.get('next')).toBe('/dashboard/settings')
    auth.aal = { currentLevel: 'aal2', nextLevel: 'aal2' }
    expect((await proxy(request('/dashboard'))).headers.get('location')).toBeNull()
  })

  it('sends someone signed in on from the sign-in pages: to `next` when it is ours', async () => {
    auth.user = { id: 'u-1' }
    expect(target(await proxy(request('/sign-up'))).pathname).toBe('/dashboard')
    const back = await proxy(request('/sign-in?next=%2Finvite%3Ftoken%3Dabc'))
    expect(`${target(back).pathname}${target(back).search}`).toBe('/invite?token=abc')
    const away = await proxy(request('/sign-in?next=https%3A%2F%2Fevil.test%2F'))
    expect(target(away).toString()).toBe(`${SITE}/dashboard`)
  })

  it('sends someone signed out from the pages that finish a sign-in', async () => {
    expect(target(await proxy(request('/verify'))).pathname).toBe('/sign-in')
    const reset = target(await proxy(request('/reset-password')))
    expect(`${reset.pathname}${reset.search}`).toBe('/forgot-password?error=expired')
  })

  it('leaves public pages to everyone', async () => {
    expect((await proxy(request('/'))).headers.get('location')).toBeNull()
    auth.user = { id: 'u-1' }
    expect((await proxy(request('/verify'))).headers.get('location')).toBeNull()
  })

  it('writes a refreshed session onto the answer, a redirect included', async () => {
    auth.refreshed = [{ name: 'sb-access', value: 'new', options: { httpOnly: true } }]
    auth.user = { id: 'u-1' }
    const through = await proxy(request('/dashboard'))
    expect(through.cookies.get('sb-access')?.value).toBe('new')
    auth.user = null
    const redirected = await proxy(request('/dashboard'))
    expect(redirected.cookies.get('sb-access')?.value).toBe('new')
  })

  it('passes on the person’s browser and address, so their session records them', async () => {
    await proxy(request('/', { 'user-agent': 'Mozilla/5.0', 'x-real-ip': '102.89.1.2' }))
    expect(auth.headers).toEqual({ 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '102.89.1.2' })
  })

  it('protects the dashboard and below, not look-alikes', () => {
    expect(matches('/dashboard', ['/dashboard'])).toBe(true)
    expect(matches('/dashboard/emails', ['/dashboard'])).toBe(true)
    expect(matches('/dashboards', ['/dashboard'])).toBe(false)
  })

  it('sends an admin from the dashboard, onboarding and invites to /admin: an admin account is admin-only', async () => {
    auth.user = { id: 'u-1' }
    auth.adminStatus = { data: 'ok', error: null }
    for (const path of [
      '/dashboard',
      '/dashboard/settings/security',
      '/onboarding',
      '/invite?token=x',
    ]) {
      expect(target(await proxy(request(path))).pathname, path).toBe('/admin')
    }
    // Any admin the gate knows, even one whose code is old.
    auth.adminStatus = { data: 'needs_code', error: null }
    expect(target(await proxy(request('/dashboard'))).pathname).toBe('/admin')
    // A customer, or a check that failed, stays: nothing tells a stranger about /admin.
    auth.adminStatus = { data: 'not_admin', error: null }
    expect((await proxy(request('/dashboard'))).headers.get('location')).toBeNull()
    auth.adminStatus = { data: null, error: { code: 'PGRST202' } }
    expect((await proxy(request('/dashboard'))).headers.get('location')).toBeNull()
  })

  it('never runs on the v1 API or static files', () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    expect(matcher.test('/api/v1/emails')).toBe(false)
    expect(matcher.test('/icon.svg')).toBe(false)
    expect(matcher.test('/_next/static/chunk.js')).toBe(false)
    expect(matcher.test('/dashboard')).toBe(true)
    expect(matcher.test('/')).toBe(true)
  })
})

describe('the door to /admin (MAIL-SPEC §10, the shop’s D9)', () => {
  const stranger = (response: Response) =>
    response.headers.get('x-middleware-request-x-mdh-stranger')
  const scriptSrc = (csp: string | null) =>
    (csp ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('script-src ')) ?? ''

  it('marks a signed-out visitor’s request for the 404 rewrite, with the site’s own CSP and nothing of an admin’s', async () => {
    for (const path of ['/admin', '/admin/accounts', '/admin/accounts/x.png']) {
      const response = await proxy(request(path))
      expect(stranger(response), path).toBe('1')
      expect(response.headers.get('location'), path).toBeNull()
      expect(response.headers.get('x-robots-tag'), path).toBeNull()
      expect(response.headers.get('x-middleware-rewrite'), path).toBeNull()
      const csp = response.headers.get('content-security-policy')
      expect(scriptSrc(csp), path).toContain("'unsafe-inline'")
      expect(scriptSrc(csp), path).not.toMatch(/'nonce-/)
    }
    expect(auth.rpcCalls).toEqual([])
  })

  it('marks a customer, and anyone the database cannot place, the same way', async () => {
    auth.user = { id: 'u-1' }
    expect(stranger(await proxy(request('/admin')))).toBe('1')
    auth.adminStatus = { data: 'something else', error: null }
    expect(stranger(await proxy(request('/admin')))).toBe('1')
    auth.adminStatus = { data: null, error: { code: '42501' } }
    expect(stranger(await proxy(request('/admin')))).toBe('1')
    expect(auth.rpcCalls).toEqual(['admin_status', 'admin_status', 'admin_status'])
  })

  it('lets an admin in under a fresh nonce CSP, unindexed and uncached, and drops a mark the browser sent', async () => {
    auth.user = { id: 'u-1' }
    auth.adminStatus = { data: 'ok', error: null }
    const response = await proxy(request('/admin/accounts', { 'x-mdh-stranger': '1' }))
    expect(stranger(response)).toBeNull()
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const csp = response.headers.get('content-security-policy')
    expect(scriptSrc(csp)).toMatch(/'nonce-[A-Za-z0-9+/=]{16,}' 'strict-dynamic'/)
    expect(scriptSrc(csp)).not.toContain("'unsafe-inline'")
    // Next stamps its own scripts with the nonce it reads from the request.
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
    const again = await proxy(request('/admin/accounts'))
    expect(again.headers.get('content-security-policy')).not.toBe(csp)
  })

  it('asks an admin whose code is old for one first, and lets the two explained refusals reach the layout', async () => {
    auth.user = { id: 'u-1' }
    auth.adminStatus = { data: 'needs_code', error: null }
    const verify = await proxy(request('/admin/accounts?state=paused'))
    expect(target(verify).pathname).toBe('/verify')
    expect(target(verify).searchParams.get('next')).toBe('/admin/accounts?state=paused')
    expect(verify.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    for (const word of ['factor_mismatch', 'weak_sign_in']) {
      auth.adminStatus = { data: word, error: null }
      const response = await proxy(request('/admin'))
      expect(stranger(response), word).toBeNull()
      expect(response.headers.get('location'), word).toBeNull()
    }
  })

  it('sends an admin signed in at /sign-in?next=/admin straight there', async () => {
    auth.user = { id: 'u-1' }
    const response = await proxy(request('/sign-in?next=%2Fadmin%2Freview'))
    expect(target(response).pathname).toBe('/admin/review')
  })

  it('matches every /admin path, a name like an image included', () => {
    expect(config.matcher).toContain('/admin')
    expect(config.matcher).toContain('/admin/:path*')
    const first = new RegExp(`^${config.matcher[0]}$`)
    expect(first.test('/admin/accounts/x.png')).toBe(false)
  })
})
