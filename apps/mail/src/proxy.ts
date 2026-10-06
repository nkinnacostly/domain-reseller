import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { safeNext } from '@/features/auth/lib/redirect'
import { env } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from '@/lib/supabase/cookies'
import { forwardedAuthHeaders } from '@/lib/supabase/forwarded'

/**
 * Next 16's proxy (the old middleware): refresh the Supabase session cookie
 * and gate the signed-in pages. Thin — it runs on every matched request.
 *
 * The v1 API (`/api/*`) is not matched: its callers carry an API key, not a
 * session, and must not pay for a session refresh on every send.
 */

/** The signed-in pages (MAIL-SPEC §10), onboarding and the invite page. */
export const PROTECTED = ['/dashboard', '/onboarding', '/invite']
export const SIGN_IN_PATH = '/sign-in'
/** Pages for signed-out people; someone signed in is sent on. */
export const SIGNED_OUT_ONLY = ['/sign-in', '/sign-up', '/forgot-password']
/** Need a session, but a partial one is fine — they are how you complete it. */
export const SESSION_REQUIRED = ['/verify', '/reset-password']

export const matches = (pathname: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      // A refresh rewrites the session's device and address: send the person's.
      global: { headers: forwardedAuthHeaders(request.headers) },
      cookieOptions: SESSION_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // Refreshes the token. Do not remove — Server Components cannot write cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname, search } = request.nextUrl
  const redirectTo = (path: string, params: Record<string, string> = {}) => {
    const target = request.nextUrl.clone()
    const [route = '/', query = ''] = path.split('?')
    target.pathname = route
    target.search = query ? `?${query}` : ''
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
    const redirect = NextResponse.redirect(target)
    // A refresh that ended the session still clears its cookies on the way out.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie)
    return redirect
  }

  if (matches(pathname, PROTECTED)) {
    if (!user) return redirectTo(SIGN_IN_PATH, { next: `${pathname}${search}` })
    // Two-factor on but not yet entered this session: finish signing in first.
    // Decoded from the JWT — no network call.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      return redirectTo('/verify', { next: `${pathname}${search}` })
    }
  }

  if (matches(pathname, SIGNED_OUT_ONLY) && user) {
    // Only /sign-in honours `next`: sign-up and a reset send everyone to the dashboard.
    const next = matches(pathname, [SIGN_IN_PATH]) ? request.nextUrl.searchParams.get('next') : null
    return redirectTo(safeNext(next, request.nextUrl.origin))
  }

  if (matches(pathname, SESSION_REQUIRED) && !user) {
    return redirectTo(
      pathname === '/reset-password' ? '/forgot-password?error=expired' : SIGN_IN_PATH,
    )
  }

  return response
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt)$).*)',
  ],
}
