/**
 * How someone SQL does not know as an admin gets a 404 at Mail's /admin
 * (MAIL-SPEC §10, M5; the shop's ADMIN-SPEC §2.3, D9). Plain constants with
 * no imports: next.config.ts loads them.
 *
 * The proxy decides, and marks such a request with STRANGER_HEADER (and
 * strips the header from everyone else's); next.config.ts's `beforeFiles`
 * rewrite sends a marked /admin request to ADMIN_NOT_FOUND_PATH, a path no
 * page answers, so Next renders Mail's own 404 with status 404. Its
 * `fallback` rewrite sends every other path no page answers to the same
 * place, so the two 404s are one: an RSC request is told
 * `x-nextjs-rewritten-path` by both, and neither source captures a param
 * into the payload's query. The rewrite is the config's, never the proxy's:
 * a proxy rewrite answers with `x-middleware-rewrite`, which no other 404
 * carries. Should the mark ever not reach the rewrite, the admin layout still
 * shows a stranger the plain not-found page.
 */

/** A path no page answers, where every 404 for a path no page answers goes. */
export const ADMIN_NOT_FOUND_PATH = '/__not-found'

/** Set by the proxy on a stranger's /admin request only; a request header, never sent back. */
export const STRANGER_HEADER = 'x-mdh-stranger'

/** Every path except `/admin` and below (path-to-regexp group for a header rule's `source`). */
export const NOT_ADMIN = '(?!admin(?:/|$)).*'

/** `/admin` and below, in unnamed groups: they capture nothing into the 404's payload. */
export const ADMIN_SOURCES = ['/admin', '/admin/(.*)']

/**
 * Any path, for the fallback rewrite, which Next tries only once no file,
 * page or route has answered. `_next/` is left out: Next answers a missing
 * chunk there with its own plain-text 404.
 */
export const UNANSWERED = '/((?!_next/).*)'
