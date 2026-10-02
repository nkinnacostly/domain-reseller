/**
 * Options every Supabase session cookie is written with, by the proxy and the
 * server client alike (ADMIN-SPEC §5.1 hardening). `httpOnly`: no script on
 * any page — an injected one included — can read the refresh token and take
 * the session elsewhere. Nothing in the browser needs it: the one browser
 * reader, the marketing header's "signed in?" hint, reads the separate
 * `dr_signed_in` cookie the proxy keeps (features/auth/lib/signed-in-hint.ts).
 */
export const SESSION_COOKIE_OPTIONS = { httpOnly: true } as const
