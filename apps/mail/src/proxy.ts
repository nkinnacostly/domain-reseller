import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import { STRANGER_HEADER } from '@/features/admin/lib/door'
import {
  adminCsp,
  adminDecision,
  adminHeaders,
  adminNonce,
  isAdminPath,
  toAdminStatus,
} from '@/features/admin/lib/gate'
import { safeNext } from '@/features/auth/lib/redirect'
import { mailCsp, supabaseHostOf } from '@/lib/csp'
import { env } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from '@/lib/supabase/cookies'
import { forwardedAuthHeaders } from '@/lib/supabase/forwarded'
import { retryingFetch } from '@/lib/supabase/retry'

/**
 * Next 16's proxy (the old middleware): refresh the Supabase session cookie,
 * gate the signed-in pages, and keep the door to /admin (MAIL-SPEC §10, M5:
 * the shop's admins, checked in SQL on every request). Thin — it runs on
 * every matched request.
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

const supabaseHost = supabaseHostOf(env.NEXT_PUBLIC_SUPABASE_URL)
const development = env.NODE_ENV !== 'production'

/**
 * What next.config.ts puts on every page but /admin. A stranger's 404 at
 * /admin gets it from here — config headers follow the path asked for, which
 * NOT_ADMIN leaves out — so that 404 carries exactly what any other 404 on
 * Mail does (D9). Next writes the proxy's headers after the config's, and the
 * config's CSP rule comes last, so this one lands where any other 404's does.
 */
const SITE_HEADERS = { 'Content-Security-Policy': mailCsp({ supabaseHost, development }) }

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const admin = isAdminPath(pathname)
  // A nonce per admin response, set on the request too, so Next stamps its
  // own scripts with it; the admin pages never allow 'unsafe-inline'.
  const csp = admin ? adminCsp(adminNonce(), { supabaseHost, development }) : null

  const requestHeaders = () => {
    const headers = new Headers(request.headers)
    // Only the proxy marks a stranger (below): a mark sent by the browser goes.
    if (admin) headers.delete(STRANGER_HEADER)
    if (csp) headers.set('content-security-policy', csp)
    return headers
  }
  const forward = () =>
    admin
      ? NextResponse.next({ request: { headers: requestHeaders() } })
      : NextResponse.next({ request })
  let response = forward()

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      // A refresh rewrites the session's device and address: send the person's.
      // admin_status is asked once more if its connection dropped (lib/supabase/retry).
      global: { headers: forwardedAuthHeaders(request.headers), fetch: retryingFetch() },
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

  /** A refreshed session's cookies on whatever goes back, and an admin's headers. */
  const finish = (
    answer: NextResponse,
    headers: Record<string, string> | null = csp ? adminHeaders(csp) : null,
  ) => {
    if (answer !== response) {
      for (const cookie of response.cookies.getAll()) answer.cookies.set(cookie)
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
    // A refresh that ended the session still clears its cookies on the way out.
    return finish(NextResponse.redirect(target))
  }

  if (admin) {
    // The admins table, asked in SQL on every request (ADR-006). A stranger,
    // a signed-out visitor or an error all look like a page that is not
    // there, headers included (D9): the request is marked, and
    // next.config.ts's rewrite renders Mail's own 404 by the same road as any
    // path no page answers (features/admin/lib/door.ts).
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
    if (!user) return redirectTo(SIGN_IN_PATH, { next: `${pathname}${search}` })
    // Two-factor on but not yet entered this session: finish signing in first.
    // Decoded from the JWT — no network call.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      return redirectTo('/verify', { next: `${pathname}${search}` })
    }
    // An admin's account is admin-only (owner, 6 Oct 2026, as in the shop):
    // it never holds or sends with a Mail account. Only someone already in
    // the admins table is sent on, so this tells a stranger nothing (D9); a
    // failed check leaves the page be. Their password and two-factor are the
    // shop's (one sign-in, M5), kept in its account settings.
    const { data, error } = await supabase.rpc('admin_status')
    if (!error && toAdminStatus(data) !== 'not_admin') return redirectTo('/admin')
  }

  if (matches(pathname, SIGNED_OUT_ONLY) && user) {
    // Only /sign-in honours `next`: sign-up and a reset send everyone to the
    // dashboard. An admin's bookmark to /sign-in?next=/admin works signed in.
    const next = matches(pathname, [SIGN_IN_PATH]) ? request.nextUrl.searchParams.get('next') : null
    return redirectTo(safeNext(next, request.nextUrl.origin))
  }

  if (matches(pathname, SESSION_REQUIRED) && !user) {
    return redirectTo(
      pathname === '/reset-password' ? '/forgot-password?error=expired' : SIGN_IN_PATH,
    )
  }

  return finish(response)
}

/**
 * Matchers are OR'd. The first skips static files by extension, which would
 * also skip `/admin/accounts/x.png` — a page under /admin, rendered with no
 * gate and no CSP. So every /admin path is matched on its own.
 */
export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt)$).*)',
    '/admin',
    '/admin/:path*',
    // Signed-in paths, matched on their own like /admin: `/dashboard/x.png`
    // is still a page, and a server action posted to it must not skip the
    // proxy's two-factor redirect (security audit, 8 Oct 2026).
    '/dashboard',
    '/dashboard/:path*',
    '/onboarding',
    '/onboarding/:path*',
    '/invite',
    '/invite/:path*',
    '/verify',
    '/verify/:path*',
    '/reset-password',
    '/reset-password/:path*',
  ],
}
