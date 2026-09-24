import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/features/auth/queries/notices', () => ({ noteSignIn: vi.fn() }))

const { noteSignIn } = await import('@/features/auth/queries/notices')
const confirm = await import('./confirm/route')
const callback = await import('./callback/route')

const UA = 'Mozilla/5.0 (Windows NT 10.0) Firefox/140.0'
const request = (path: string) =>
  new NextRequest(`https://www.mydomainshub.com${path}`, { headers: { 'user-agent': UA } })

function supabase(result: { data: unknown; error: unknown }) {
  const auth = {
    verifyOtp: vi.fn(async () => result),
    exchangeCodeForSession: vi.fn(async () => result),
  }
  vi.mocked(createClient).mockResolvedValue({ auth } as never)
  return auth
}

beforeEach(() => vi.clearAllMocks())

describe('email links sign a device in (SEC-4)', () => {
  it('notes the device when a sign-in link works', async () => {
    supabase({ data: { user: { id: 'user-1' } }, error: null })
    const response = await confirm.GET(
      request('/auth/confirm?token_hash=h&type=email&next=/app/domains'),
    )
    expect(response.headers.get('location')).toBe('https://www.mydomainshub.com/app/domains')
    expect(noteSignIn).toHaveBeenCalledWith('user-1', UA)
  })

  it('does not count confirming a new email address as a sign-in', async () => {
    supabase({ data: { user: { id: 'user-1' } }, error: null })
    await confirm.GET(request('/auth/confirm?token_hash=h&type=email_change&next=/app/settings'))
    expect(noteSignIn).not.toHaveBeenCalled()
  })

  it('notes nothing when the link has expired', async () => {
    supabase({ data: { user: null }, error: { code: 'otp_expired' } })
    const response = await confirm.GET(request('/auth/confirm?token_hash=h&type=email'))
    expect(response.headers.get('location')).toContain('/sign-in?error=expired')
    expect(noteSignIn).not.toHaveBeenCalled()
  })

  it('notes the device when a code is exchanged for a session', async () => {
    supabase({ data: { user: { id: 'user-2' }, session: {} }, error: null })
    await callback.GET(request('/auth/callback?code=c&next=/app/domains'))
    expect(noteSignIn).toHaveBeenCalledWith('user-2', UA)
  })
})
