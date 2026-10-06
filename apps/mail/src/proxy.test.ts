import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { config, matches, proxy } from './proxy'

/**
 * The proxy refreshes the session and keeps /dashboard for the signed in.
 * Supabase Auth is the network boundary, mocked as the shop's proxy test does.
 */

type Cookie = { name: string; value: string; options?: Record<string, unknown> }

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
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
      },
    }
  },
}))

const SITE = 'https://emails.mydomainshub.com'
const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`${SITE}${path}`, { headers })

beforeEach(() => {
  auth.user = null
  auth.refreshed = []
  auth.headers = null
})

describe('proxy', () => {
  it('sends a signed-out visitor from the dashboard to sign in, and back after', async () => {
    const response = await proxy(request('/dashboard/keys?tab=all'))
    expect(response.status).toBe(307)
    const target = new URL(response.headers.get('location') ?? '')
    expect(target.pathname).toBe('/sign-in')
    expect(target.searchParams.get('next')).toBe('/dashboard/keys?tab=all')
  })

  it('lets a signed-in person through to the dashboard', async () => {
    auth.user = { id: 'u-1' }
    const response = await proxy(request('/dashboard'))
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('leaves public pages to everyone', async () => {
    const response = await proxy(request('/'))
    expect(response.headers.get('location')).toBeNull()
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
