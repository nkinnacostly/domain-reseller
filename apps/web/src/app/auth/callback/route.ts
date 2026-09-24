import { type NextRequest, NextResponse } from 'next/server'
import { safeNext } from '@/features/auth/lib/redirect'
import { noteSignIn } from '@/features/auth/queries/notices'
import { createClient } from '@/lib/supabase/server'

/**
 * Where Supabase's email links land (sign-up confirmation, sign-in link,
 * password reset). Exchanges the one-time code for a session.
 *
 * The code only works in the browser that asked for it (PKCE). Opened on
 * another device, Supabase has still confirmed the email address before
 * redirecting here — so a failed exchange on a sign-up link means "confirmed,
 * now sign in", not "broken".
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const flow = url.searchParams.get('flow')
  const code = url.searchParams.get('code')
  const next = safeNext(url.searchParams.get('next'), url.origin)
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin))

  if (code) {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // SEC-4: a new device gets a security email.
      if (data.user) await noteSignIn(data.user.id, request.headers.get('user-agent'))
      return to(next)
    }
  }

  // Supabase reports an expired or reused link as `error_code=otp_expired`.
  const expired = url.searchParams.get('error_code') !== null || !code

  if (flow === 'recovery') return to(`/forgot-password?error=${expired ? 'expired' : 'device'}`)
  if (flow === 'signup' && !expired) return to('/sign-in?notice=confirmed')
  return to(`/sign-in?error=${expired ? 'expired' : 'device'}`)
}
