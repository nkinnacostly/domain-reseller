import { env } from '@/lib/env'

/**
 * Addresses Supabase Auth sends people back to, on Mail's own host (its
 * redirect allow-list has emails.mydomainshub.com/**, MAIL-SPEC §3).
 *
 * Email links are token-hash links the shop's Send Email hook builds to
 * Mail's /auth/confirm (it knows Mail by this redirect's host), landing on
 * the redirect's own path — so a sign-up's redirect is the page to land on.
 * Google comes back to /auth/callback with a code to exchange (PKCE).
 */
export function mailUrl(path: string): string {
  return new URL(path, env.NEXT_PUBLIC_MAIL_URL).toString()
}

/** Where Google sends the person back to; `next` is where they go from there. */
export function oauthCallbackUrl(next: string): string {
  const url = new URL('/auth/callback', env.NEXT_PUBLIC_MAIL_URL)
  url.searchParams.set('flow', 'oauth')
  url.searchParams.set('next', next)
  return url.toString()
}

/** The person's own security page: password and two-factor (MAIL-SPEC §10, Settings). */
export const SECURITY_PAGE = '/dashboard/settings/security'
