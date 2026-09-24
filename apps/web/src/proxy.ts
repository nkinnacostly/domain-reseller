import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { canonicalExtensionPath } from '@/features/extensions/lib/extension'
import { env } from '@/lib/env'

/**
 * Next 16 replaced `middleware.ts` with `proxy.ts`.
 * Responsibilities: refresh the Supabase session cookie, and gate route groups.
 * Keep this thin — it runs on every matched request.
 */

/**
 * The signed-in panel lives under /app (PRD §14). Public pages such as
 * /domains/{tld} and /transfer share words with panel routes, so the prefix
 * is what keeps them apart.
 */
const PROTECTED = ['/app', '/admin']
/** Pages for signed-out people; someone signed in is sent on. */
const SIGNED_OUT_ONLY = ['/sign-in', '/sign-up', '/forgot-password']
/** Need a session, but a partial one is fine — they are how you complete it. */
const SESSION_REQUIRED = ['/verify', '/reset-password']

const matches = (pathname: string, prefixes: string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

export async function proxy(request: NextRequest) {
  // /domains/COM → /domains/com (FR-PUB1), before the page renders: see
  // canonicalExtensionPath for why the page itself must not redirect.
  const canonical = canonicalExtensionPath(request.nextUrl.pathname)
  if (canonical) {
    const target = request.nextUrl.clone()
    target.pathname = canonical
    return NextResponse.redirect(target, 308)
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
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
    target.pathname = path
    target.search = ''
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
    return NextResponse.redirect(target)
  }

  if (matches(pathname, PROTECTED)) {
    if (!user) return redirectTo('/sign-in', { next: `${pathname}${search}` })

    // Two-factor on, but not yet entered this session: finish signing in first.
    // Decoded from the JWT — no network call.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      return redirectTo('/verify', { next: `${pathname}${search}` })
    }
  }

  if (matches(pathname, SIGNED_OUT_ONLY) && user) return redirectTo('/app/domains')

  if (matches(pathname, SESSION_REQUIRED) && !user) {
    return pathname.startsWith('/reset-password')
      ? redirectTo('/forgot-password', { error: 'expired' })
      : redirectTo('/sign-in')
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif)$).*)',
  ],
}
