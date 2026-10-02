/**
 * A cookie the proxy sets to `1` while a session exists and removes when it
 * does not. The session cookies themselves are httpOnly (ADMIN-SPEC §5.1),
 * so this is how a prerendered page's header knows whom to greet. It says
 * nothing else, and nothing trusts it for access (the proxy and RLS do that).
 */
export const SIGNED_IN_HINT = 'dr_signed_in'

/** Whether a `document.cookie` string carries the hint. */
export function hasSignedInHint(cookie: string): boolean {
  return cookie.split(';').some((part) => part.trim() === `${SIGNED_IN_HINT}=1`)
}
