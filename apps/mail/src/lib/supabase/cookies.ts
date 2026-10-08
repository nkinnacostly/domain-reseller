import { env } from '@/lib/env'

/**
 * Options every Supabase session cookie is written with, by the proxy and the
 * server client alike, as in the shop (ADMIN-SPEC §5.1 hardening):
 * `httpOnly`, so no script on any page — an injected one included — can read
 * the refresh token and take the session elsewhere.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  // Never sent over plain http where the site is https (security audit,
  // 8 Oct 2026). The e2e server runs on http://localhost, so it follows the
  // site's own address rather than NODE_ENV.
  secure: env.NEXT_PUBLIC_MAIL_URL.startsWith('https://'),
} as const
