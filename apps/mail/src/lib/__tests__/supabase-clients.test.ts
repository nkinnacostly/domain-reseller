import { HttpResponse, http } from 'msw'
import { cookies, headers } from 'next/headers'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../../tests/mocks/server'
import { SUPABASE_URL } from '../../../tests/mocks/supabase'
import { mailCsp, supabaseHostOf } from '../csp'
import { createPublicClient } from '../supabase/public'
import { createClient } from '../supabase/server'
import { createServiceClient } from '../supabase/service'

vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }))

/** Every Mail client reads schema `mail` (M5), and each with its own key. */

function recordReads() {
  const seen: { profile: string | null; apikey: string | null }[] = []
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/plans`, ({ request }) => {
      seen.push({
        profile: request.headers.get('accept-profile'),
        apikey: request.headers.get('apikey'),
      })
      return HttpResponse.json([])
    }),
  )
  return seen
}

describe('Mail’s Supabase clients', () => {
  it('the public client reads plans in schema mail with the publishable key', async () => {
    const seen = recordReads()
    await createPublicClient()
      .from('plans' as never)
      .select('*')
    expect(seen).toEqual([{ profile: 'mail', apikey: 'test-publishable-key' }])
  })

  it('the service client reads schema mail with the secret key, and needs it', async () => {
    const seen = recordReads()
    await createServiceClient()
      .from('plans' as never)
      .select('*')
    expect(seen).toEqual([{ profile: 'mail', apikey: 'sb_test' }])
    vi.stubEnv('SUPABASE_SECRET_KEY', '')
    vi.resetModules()
    const { createServiceClient: fresh } = await import('../supabase/service')
    expect(fresh).toThrow('SUPABASE_SECRET_KEY')
    vi.unstubAllEnvs()
  })

  it('the session client reads schema mail as the person, with their cookies', async () => {
    const set = vi.fn()
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [], set } as never)
    vi.mocked(headers).mockResolvedValue(new Headers({ 'user-agent': 'Mozilla/5.0' }) as never)
    const seen = recordReads()
    await (await createClient()).from('plans' as never).select('*')
    expect(seen).toEqual([{ profile: 'mail', apikey: 'test-publishable-key' }])
  })
})

describe('the Content Security Policy', () => {
  it('lets the browser talk to this site and our Supabase project only', () => {
    const csp = mailCsp({ supabaseHost: 'abc.supabase.co', development: false })
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-eval')
    expect(mailCsp({ supabaseHost: 'x', development: true })).toContain("'unsafe-eval'")
  })

  it('reads the project’s host, or falls back to any Supabase host', () => {
    expect(supabaseHostOf('https://abc.supabase.co')).toBe('abc.supabase.co')
    expect(supabaseHostOf(undefined)).toBe('*.supabase.co')
    expect(supabaseHostOf('not a url')).toBe('*.supabase.co')
  })
})
