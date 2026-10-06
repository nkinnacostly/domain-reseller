/**
 * Options every Supabase session cookie is written with, by the proxy and the
 * server client alike, as in the shop (ADMIN-SPEC §5.1 hardening):
 * `httpOnly`, so no script on any page — an injected one included — can read
 * the refresh token and take the session elsewhere.
 */
export const SESSION_COOKIE_OPTIONS = { httpOnly: true } as const
