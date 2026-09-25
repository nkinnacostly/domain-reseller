import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const { continueWithGoogle } = await import('../actions/oauth')

function supabase(result: {
  data: { url: string | null } | null
  error: { message: string } | null
}) {
  const signInWithOAuth = vi.fn(async () => result)
  vi.mocked(createClient).mockResolvedValue({ auth: { signInWithOAuth } } as never)
  return signInWithOAuth
}

/** The URL a server action redirected to. */
async function redirectTarget(pending: Promise<unknown>): Promise<string> {
  try {
    await pending
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? ''
    if (digest.startsWith('NEXT_REDIRECT')) return digest.split(';')[2] ?? ''
    throw error
  }
  return ''
}

beforeEach(() => vi.clearAllMocks())

describe('continueWithGoogle (FR-A1)', () => {
  it('starts Google sign-in, coming back to our callback and on to where they were going', async () => {
    const start = supabase({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
      error: null,
    })
    const target = await redirectTarget(continueWithGoogle({ next: '/app/checkout' }))

    expect(target).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1')
    const [call] = start.mock.calls[0] as unknown as [
      { provider: string; options: Record<string, unknown> },
    ]
    expect(call.provider).toBe('google')
    expect(call.options.skipBrowserRedirect).toBe(true)
    expect(call.options.queryParams).toEqual({ prompt: 'select_account' })
    const back = new URL(String(call.options.redirectTo))
    expect(back.pathname).toBe('/auth/callback')
    expect(back.searchParams.get('flow')).toBe('oauth')
    expect(back.searchParams.get('next')).toBe('/app/checkout')
  })

  it('never sends someone on to another site afterwards', async () => {
    const start = supabase({ data: { url: 'https://accounts.google.com/x' }, error: null })
    await redirectTarget(continueWithGoogle({ next: 'https://evil.example/steal' }))
    const [call] = start.mock.calls[0] as unknown as [{ options: { redirectTo: string } }]
    expect(new URL(call.options.redirectTo).searchParams.get('next')).toBe('/app/domains')
  })

  it('says so when Google sign-in cannot start, and goes nowhere', async () => {
    supabase({ data: null, error: { message: 'Unsupported provider: provider is not enabled' } })
    const result = await continueWithGoogle({ next: '/app/domains' })
    expect(result?.data).toEqual({
      error: 'Google sign-in is not available just now. Use your email instead.',
    })
  })
})
