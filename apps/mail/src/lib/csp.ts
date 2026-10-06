/**
 * Mail's Content Security Policy, as the shop's (PRD SEC-15): scripts,
 * styles and fonts from this site only; the browser talks to this site and
 * our Supabase project only. `'unsafe-inline'` stays for scripts because
 * Next's bootstrap is inline; dev adds `'unsafe-eval'` for React's tooling.
 *
 * The outside origins, as the shop's: Cloudflare Turnstile's script and the
 * challenge frame it draws on the forms that send email (§7.1), and, for
 * "Continue with Google", Supabase Auth and Google as form destinations.
 * Plain TypeScript with no imports: next.config.ts loads it.
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/** Our Supabase project's host, from its URL; a wildcard if the URL is missing or bad. */
export function supabaseHostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').host || '*.supabase.co'
  } catch {
    return '*.supabase.co'
  }
}

export function mailCsp(options: { supabaseHost: string; development: boolean }): string {
  const supabase = options.supabaseHost
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${TURNSTILE_ORIGIN}${options.development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://${supabase} wss://${supabase}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' https://${supabase} https://accounts.google.com`,
  ].join('; ')
}
