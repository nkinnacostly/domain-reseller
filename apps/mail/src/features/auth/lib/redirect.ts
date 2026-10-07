/**
 * Where to send someone after they sign in, as the shop does it.
 *
 * `next` arrives in a URL, so it is attacker-controlled: an unchecked value
 * turns our sign-in page into an open redirect that lends our domain to a
 * phishing link. Only same-origin paths survive; everything else falls back
 * to the dashboard.
 */
export const DEFAULT_AFTER_SIGN_IN = '/dashboard'

/** The pages that sign people in: never a place to be sent back to. */
const AUTH_PAGES = /^\/(sign-in|sign-up|forgot-password|reset-password|verify|auth)(\/|$)/

export function safeNext(
  next: string | null | undefined,
  origin: string,
  fallback: string = DEFAULT_AFTER_SIGN_IN,
): string {
  if (!next) return fallback

  let url: URL
  try {
    // Relative paths resolve against our origin; absolute ones keep their own.
    url = new URL(next, origin)
  } catch {
    return fallback
  }

  if (url.origin !== new URL(origin).origin) return fallback
  // `//evil.com` and `/\evil.com` are protocol-relative in some browsers. Test
  // both what was sent and what the parser made of it: `/.//evil.com`,
  // `/x/..//evil.com` and `/%2e%2e//evil.com` normalise to `//evil.com`.
  if (/^\/[/\\]/.test(next) || /^\/[/\\]/.test(url.pathname)) return fallback

  if (url.pathname === '/' || AUTH_PAGES.test(url.pathname)) return fallback
  return `${url.pathname}${url.search}${url.hash}`
}
