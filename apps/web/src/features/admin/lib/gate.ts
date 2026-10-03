import { safeNext } from '@/features/auth/lib/redirect'

/**
 * What the proxy does at `/admin` (docs/ADMIN-SPEC.md §2.3, D9). Pure, so the
 * decisions are tested without a request.
 *
 * - A stranger, a signed-out visitor, or a database that cannot say gets a
 *   404: the plain not-found page, with no admin words. Its headers are every
 *   /admin answer's (noindex, no-store, a nonce CSP) — a 404 there must never
 *   be cached — so they do show the path is special (D9, accepted).
 * - An admin whose code is missing or too old enters one first.
 * - An admin signed in the wrong way, or on an unlinked device, reaches the
 *   layout, which says what to do — never the pages.
 */

export const ADMIN_PREFIX = '/admin'

export type AdminStatus = 'ok' | 'needs_code' | 'factor_mismatch' | 'weak_sign_in' | 'not_admin'

const STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'needs_code',
  'factor_mismatch',
  'weak_sign_in',
  'not_admin',
])

/** admin_status()'s word; anything else — an error, a missing function — is `not_admin`. */
export function toAdminStatus(value: unknown): AdminStatus {
  return typeof value === 'string' && STATUSES.has(value) ? (value as AdminStatus) : 'not_admin'
}

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`)
}

export type AdminDecision = { kind: 'not_found' } | { kind: 'verify' } | { kind: 'continue' }

export function adminDecision(status: AdminStatus): AdminDecision {
  if (status === 'not_admin') return { kind: 'not_found' }
  if (status === 'needs_code') return { kind: 'verify' }
  return { kind: 'continue' }
}

/** Where the proxy rewrites strangers: a path no page answers, so Next renders its 404. */
export const ADMIN_NOT_FOUND_PATH = '/__admin-not-found'

/**
 * D9: someone already signed in who opens `/sign-in?next=/admin…` is sent
 * straight there (the owner's bookmark), and everyone else to their panel.
 */
export function signedInDestination(next: string | null, origin: string): string {
  const path = safeNext(next, origin)
  return isAdminPath(path.split(/[?#]/)[0] ?? '') ? path : '/app/domains'
}

/** A fresh nonce for one admin response's scripts. */
export function adminNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

/**
 * The admin area's policy (§2.3): scripts only with this response's nonce —
 * no `'unsafe-inline'` — nothing framed, no base or object tags. The rest of
 * the site keeps next.config.ts's policy, whose `source` leaves `/admin` out.
 */
export function adminCsp(
  nonce: string,
  options: { supabaseHost: string; development: boolean },
): string {
  const host = options.supabaseHost
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://${host} wss://${host}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
}

/** Every `/admin` response: never indexed, never cached, never framed (§2.3). */
export function adminHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'private, no-store',
  }
}
