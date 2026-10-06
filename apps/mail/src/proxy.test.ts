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

  it('never runs on the v1 API or static files', () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    expect(matcher.test('/api/v1/emails')).toBe(false)
    expect(matcher.test('/icon.svg')).toBe(false)
    expect(matcher.test('/_next/static/chunk.js')).toBe(false)
    expect(matcher.test('/dashboard')).toBe(true)
    expect(matcher.test('/')).toBe(true)
  })
})
