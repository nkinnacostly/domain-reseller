import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import {
  adminCsp,
  adminDecision,
  adminHeaders,
  adminNonce,
  isAdminPath,
  STRANGER_HEADER,
  signedInDestination,
  toAdminStatus,
} from '@/features/admin/lib/gate'
import { SIGNED_IN_HINT } from '@/features/auth/lib/signed-in-hint'
import { canonicalExtensionPath } from '@/features/extensions/lib/extension'
import { siteCsp, supabaseHostOf } from '@/lib/csp'
import { env } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from '@/lib/supabase/cookies'
import { forwardedAuthHeaders } from '@/lib/supabase/forwarded'

/**
 * Next 16 replaced `middleware.ts` with `proxy.ts`.
 * Responsibilities: refresh the Supabase session cookie, and gate route groups.
 * Keep this thin — it runs on every matched request.
 */

/**
 * The signed-in panel lives under /app (PRD §14). Public pages such as
 * /domains/{tld} and /transfer share words with panel routes, so the prefix
 * is what keeps them apart. /admin has its own gate below (ADMIN-SPEC §2.3).
 */
const PROTECTED = ['/app']
/**
 * An admin's account is for the admin area only (owner, 6 Oct 2026): its
 * customer pages send it to /admin, so it is never used to buy or hold
 * domains. Its own settings stay — password, two-factor and sessions are how
 * the admin's sign-in is kept safe.
 */
const ADMIN_ACCOUNT_KEEPS = ['/app/settings']
/** Pages for signed-out people; someone signed in is sent on. */
const SIGNED_OUT_ONLY = ['/sign-in', '/sign-up', '/forgot-password']
/** Need a session, but a partial one is fine — they are how you complete it. */
const SESSION_REQUIRED = ['/verify', '/reset-password']

const matches = (pathname: string, prefixes: string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

const supabaseHost = supabaseHostOf(env.NEXT_PUBLIC_SUPABASE_URL)

/**
 * What next.config.ts puts on every page but /admin. A stranger's 404 at
 * /admin gets it from here — config headers follow the path asked for, which
 * NOT_ADMIN leaves out — so that 404 carries exactly what any other 404 does.
 * Next writes the proxy's headers after the config's, and the config's CSP
 * rule comes last, so this one lands where any other 404's does (D9).
 */
const SITE_HEADERS = {
  'Content-Security-Policy': siteCsp({
    supabaseHost,
    development: env.NODE_ENV !== 'production',
  }),
}

/** 400 days, the longest a browser keeps a cookie: the hint lives as long as a session can. */
const HINT_MAX_AGE = 400 * 24 * 60 * 60

export async function proxy(request: NextRequest) {
  // /domains/COM → /domains/com (FR-PUB1), before the page renders: see
  // canonicalExtensionPath for why the page itself must not redirect.
  const canonical = canonicalExtensionPath(request.nextUrl.pathname)
  if (canonical) {
    const target = request.nextUrl.clone()
    target.pathname = canonical
    return NextResponse.redirect(target, 308)
  }

  const { pathname, search } = request.nextUrl
  const admin = isAdminPath(pathname)
  // §2.3: a nonce per admin response. Set on the request too, so Next stamps
  // its own scripts with it; the admin pages never allow 'unsafe-inline'.
  const csp = admin
    ? adminCsp(adminNonce(), {
        supabaseHost,
        development: env.NODE_ENV !== 'production',
      })
    : null

  const requestHeaders = () => {
    const headers = new Headers(request.headers)
    // Only the proxy marks a stranger (below): a mark sent by the browser goes.
    if (admin) headers.delete(STRANGER_HEADER)
    if (csp) headers.set('content-security-policy', csp)
    return headers
  }
  const forward = () => NextResponse.next({ request: { headers: requestHeaders() } })
  let response = forward()

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      // A refresh here rewrites the session's device and address: send the
      // person's, or every session reads as our server (FR-A5).
      global: { headers: forwardedAuthHeaders(request.headers) },
      // No script on any page can read the refresh token (ADMIN-SPEC §5.1).
      cookieOptions: SESSION_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
          response = forward()
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

  /**
   * Every answer carries the signed-in hint, and an admin answer its headers
   * — or, for a stranger's 404 at /admin, the site's own instead.
   */
  const finish = (
    answer: NextResponse,
    headers: Record<string, string> | null = csp ? adminHeaders(csp) : null,
  ) => {
    for (const cookie of response.cookies.getAll()) {
      if (answer !== response) answer.cookies.set(cookie)
    }
    const hinted = request.cookies.get(SIGNED_IN_HINT)?.value === '1'
    if (user && !hinted) {
      // Readable by script on purpose: it says only that a session exists.
      answer.cookies.set(SIGNED_IN_HINT, '1', { path: '/', sameSite: 'lax', maxAge: HINT_MAX_AGE })
    } else if (!user && hinted) {
      answer.cookies.delete(SIGNED_IN_HINT)
    }
    for (const [name, value] of Object.entries(headers ?? {})) answer.headers.set(name, value)
    return answer
  }

  const redirectTo = (path: string, params: Record<string, string> = {}) => {
    const target = request.nextUrl.clone()
    const [route = '/', query = ''] = path.split('?')
    target.pathname = route
    target.search = query ? `?${query}` : ''
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
    return finish(NextResponse.redirect(target))
  }

  if (admin) {
    // D1/D2: the admins table, checked in SQL on every request. A stranger,
    // a signed-out visitor or an error all look like a page that is not there
    // — headers included, however the browser asks (D9). The request is
    // marked, and next.config.ts's rewrite renders Next's own 404 by the same
    // road as any path no page answers (features/admin/lib/door.ts); it
    // carries no nonce, so Next stamps none, and the answer gets the site's
    // CSP and none of the admin headers.
    let status = toAdminStatus(null)
    if (user) {
      const { data, error } = await supabase.rpc('admin_status')
      status = error ? 'not_admin' : toAdminStatus(data)
    }
    const decision = adminDecision(status)
    if (decision.kind === 'not_found') {
      const headers = new Headers(request.headers)
      headers.set(STRANGER_HEADER, '1')
      return finish(NextResponse.next({ request: { headers } }), SITE_HEADERS)
    }
    if (decision.kind === 'verify') return redirectTo('/verify', { next: `${pathname}${search}` })
    return finish(response)
  }

  if (matches(pathname, PROTECTED)) {
    if (!user) return redirectTo('/sign-in', { next: `${pathname}${search}` })

    // Two-factor on, but not yet entered this session: finish signing in first.
    // Decoded from the JWT — no network call.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      return redirectTo('/verify', { next: `${pathname}${search}` })
    }

    // Only someone already in the admins table is sent on, so this tells a
    // stranger nothing about /admin (D9). A failed check leaves the page be.
    if (!matches(pathname, ADMIN_ACCOUNT_KEEPS)) {
      const { data, error } = await supabase.rpc('admin_status')
      if (!error && toAdminStatus(data) !== 'not_admin') return redirectTo('/admin')
    }
  }

  if (matches(pathname, SIGNED_OUT_ONLY) && user) {
    // D9: the owner's bookmark to /sign-in?next=/admin works signed in too.
    // Only /sign-in: sign-up and password reset send everyone to their panel.
    const next = matches(pathname, ['/sign-in']) ? request.nextUrl.searchParams.get('next') : null
    return redirectTo(signedInDestination(next, request.nextUrl.origin))
  }

  if (matches(pathname, SESSION_REQUIRED) && !user) {
    return pathname.startsWith('/reset-password')
      ? redirectTo('/forgot-password', { error: 'expired' })
      : redirectTo('/sign-in')
  }

  return finish(response)
}

/**
 * Matchers are OR'd. The first skips static files by extension, which would
 * also skip `/admin/orders/x.png` — a page under /admin, rendered with no
 * gate, no CSP and no X-Robots-Tag. So every /admin path is matched on its
 * own (ADMIN-SPEC §2.3).
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif)$).*)',
    '/admin',
    '/admin/:path*',
  ],
}
