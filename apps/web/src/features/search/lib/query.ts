/**
 * Normalising what people actually type into a domain search.
 *
 * Real input includes `https://`, `www.`, trailing paths, stray spaces and
 * capitals. Cleaning this up before it reaches the supplier saves a wasted API
 * call and, more importantly, stops us telling someone their domain is invalid
 * when they simply pasted a URL.
 */
export type ParsedQuery = {
  /** The searchable label, e.g. `getpaid`. Empty when the input has nothing usable. */
  stem: string
  /** The extension the user typed, if any, without the leading dot. */
  tld: string | null
  /** True when the input parsed to something we can search. */
  isValid: boolean
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

export function parseSearchQuery(raw: string): ParsedQuery {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // strip scheme
    .replace(/^www\./, '')
    .split(/[/?#]/)[0] // drop path, query, fragment
    ?.replace(/\.$/, '') // drop a trailing dot
    .replace(/\s+/g, '')

  if (!cleaned) return { stem: '', tld: null, isValid: false }

  const parts = cleaned.split('.').filter(Boolean)
  const stem = parts[0] ?? ''

  if (!LABEL.test(stem)) return { stem, tld: null, isValid: false }

  // Multi-label extensions such as `com.ng` must survive intact.
  const tld = parts.length > 1 ? parts.slice(1).join('.') : null
  if (tld && !tld.split('.').every((label) => LABEL.test(label))) {
    return { stem, tld: null, isValid: false }
  }

  return { stem, tld, isValid: true }
}

/** Builds the canonical search URL so every entry point agrees on the shape. */
export function searchHref(raw: string): string {
  const { stem, tld, isValid } = parseSearchQuery(raw)
  if (!isValid) return '/search'
  return `/search?q=${encodeURIComponent(tld ? `${stem}.${tld}` : stem)}`
}
