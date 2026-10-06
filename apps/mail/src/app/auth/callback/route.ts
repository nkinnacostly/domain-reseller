import { type NextRequest, NextResponse } from 'next/server'
import { safeNext } from '@/features/auth/lib/redirect'
import { noteSignIn } from '@/features/auth/queries/notices'
import { createClient } from '@/lib/supabase/server'

/**
 * Where Google sends the person back (MAIL-SPEC §7.1): exchanges the one-time
 * code for a session. The code only works in the browser that asked for it
 * (PKCE); without one, Google was cancelled or refused.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeNext(url.searchParams.get('next'), url.origin)
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin))

  if (code) {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // The shop's SEC-4: a new device gets a security email.
      if (data.user) await noteSignIn(data.user.id, request.headers.get('user-agent'))
      return to(next)
    }
  }

  if (url.searchParams.get('flow') === 'oauth') {
    return to(`/sign-in?error=oauth&next=${encodeURIComponent(next)}`)
  }
  return to(`/sign-in?error=${code ? 'device' : 'expired'}`)
}
