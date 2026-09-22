import type { EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { safeNext } from '@/features/auth/lib/redirect'
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
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) return to(type === 'recovery' ? '/reset-password' : next)
  }

  return to(type === 'recovery' ? '/forgot-password?error=expired' : '/sign-in?error=expired')
}
