import type { EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { safeNext } from '@/features/auth/lib/redirect'
import { noteSignIn } from '@/features/auth/queries/notices'
import { createClient } from '@/lib/supabase/server'

const TYPES = new Set<EmailOtpType>(['email', 'recovery', 'email_change', 'signup', 'magiclink'])

/**
 * Token-hash links, which work on any device. Used once custom email
 * templates are enabled (supabase/templates, needs custom SMTP — CLAUDE.md §15).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type') as EmailOtpType | null
  const next = safeNext(url.searchParams.get('next'), url.origin)
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin))

  if (tokenHash && type && TYPES.has(type)) {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) {
      // SEC-4: an email link signs this device in; a new one gets a security email.
      if (data.user && type !== 'email_change') {
        await noteSignIn(data.user.id, request.headers.get('user-agent'))
      }
      return to(type === 'recovery' ? '/reset-password' : next)
    }
  }

  return to(type === 'recovery' ? '/forgot-password?error=expired' : '/sign-in?error=expired')
}
