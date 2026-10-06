/**
 * Mail's Content Security Policy, as the shop's (PRD SEC-15): scripts,
 * styles and fonts from this site only; the browser talks to this site and
 * our Supabase project only. `'unsafe-inline'` stays for scripts because
 * Next's bootstrap is inline; dev adds `'unsafe-eval'` for React's tooling.
 * Plain TypeScript with no imports: next.config.ts loads it.
 */

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
    `script-src 'self' 'unsafe-inline'${options.development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://${supabase} wss://${supabase}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' https://${supabase}`,
  ].join('; ')
}
