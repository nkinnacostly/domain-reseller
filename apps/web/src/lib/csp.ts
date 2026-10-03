/**
 * The site's Content Security Policy (PRD SEC-15). Scripts, styles and fonts
 * come only from this site; the browser talks only to this site and our
 * Supabase project. So an injected script could neither load code from
 * elsewhere nor send anything it read to another host. Payment happens on
 * Flutterwave's own page, reached by navigation, so none of its code runs here.
 *
 * `'unsafe-inline'` stays for scripts because Next's bootstrap is inline and
 * this site has no nonce plumbing; the other directives still hold. Dev adds
 * `'unsafe-eval'` for React's tooling.
 *
 * The one outside origin is Cloudflare Turnstile (SEC-9): its script and the
 * challenge frame it draws, on the forms that send email and when a search
 * asks for a check (components/common/turnstile.tsx). It talks to Cloudflare
 * from inside its own frame, so connect-src does not change.
 *
 * One copy for two senders: `next.config.ts` puts it on every path but
 * `/admin`, and the proxy puts it on a stranger's 404 at `/admin`, so that
 * answer carries exactly the headers any other 404 does (ADMIN-SPEC D9).
 * Plain TypeScript with no imports: next.config.ts loads it.
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/** Our Supabase project's host, from its URL; a wildcard if the URL is missing or bad. */
export function supabaseHostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').host
  } catch {
    return '*.supabase.co'
  }
}

export function siteCsp(options: { supabaseHost: string; development: boolean }): string {
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
    // FR-A1: "Continue with Google" is a form whose answer sends the browser to
    // Supabase Auth, which sends it on to Google — without these, a browser
    // enforcing form-action on redirects stops it.
    `form-action 'self' https://${supabase} https://accounts.google.com`,
  ].join('; ')
}
