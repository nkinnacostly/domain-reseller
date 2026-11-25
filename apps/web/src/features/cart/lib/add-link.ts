/**
 * A link that fills a cart (feature 8): `/cart/add?d=getpaid.ng,getpaid.com`.
 * Opening it adds nothing — the page lists the names and their prices, and
 * the person adds them with a button, which checks each name again (FR-S6).
 * Assistants make these through the MCP server; anyone may share one.
 */

export const CART_ADD_PATH = '/cart/add'
export const MAX_LINK_DOMAINS = 20

export function cartAddHref(domains: readonly string[]): string {
  return `${CART_ADD_PATH}?d=${domains.map((domain) => encodeURIComponent(domain)).join(',')}`
}

/** The names in `?d=`: trimmed, lower-cased, distinct, at most MAX_LINK_DOMAINS. */
export function parseCartAddParam(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw.join(',') : (raw ?? '')
  return [
    ...new Set(
      value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length >= 3 && part.length <= 253),
    ),
  ].slice(0, MAX_LINK_DOMAINS)
}
