import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from '@/lib/supabase/cookies'
import { forwardedAuthHeaders } from '@/lib/supabase/forwarded'

/**
 * Next 16's proxy (the old middleware): refresh the Supabase session cookie
 * and gate the signed-in area. Thin — it runs on every matched request.
 *
 * The v1 API (`/api/*`) is not matched: its callers carry an API key, not a
 * session, and must not pay for a session refresh on every send.
 */

/** The signed-in area (MAIL-SPEC §10). */
export const PROTECTED = ['/dashboard']
export const SIGN_IN_PATH = '/sign-in'

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
  if (matches(pathname, PROTECTED) && !user) {
    const target = request.nextUrl.clone()
    target.pathname = SIGN_IN_PATH
    target.search = ''
    target.searchParams.set('next', `${pathname}${search}`)
    const redirect = NextResponse.redirect(target)
    // A refresh that ended the session still clears its cookies on the way out.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie)
    return redirect
  }

  return response
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt)$).*)',
  ],
}
