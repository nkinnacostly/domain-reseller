import { mixedScripts, toAsciiHost, toUnicodeHost, toUnicodeLabel } from './idn'

/**
 * Normalising what people actually type into a domain search.
 *
 * Real input includes `https://`, `www.`, trailing paths, stray spaces and
 * capitals. Cleaning this up before it reaches the supplier saves a wasted API
 * call and, more importantly, stops us telling someone their domain is invalid
 * when they simply pasted a URL.
 *
 * Names in other scripts are accepted and turned into their ASCII (Punycode)
 * form here (FR-S8): `stem` and `tld` are always what the supplier is asked
 * about and what a cart stores. `toUnicodeHost` gives back the form to show.
 */
export type ParsedQuery = {
  /** The searchable label in ASCII, e.g. `getpaid` or `xn--caf-dma`. Empty when the input has nothing usable. */
  stem: string
  /** The extension the user typed, if any, without the leading dot. */
  tld: string | null
  /** True when the input parsed to something we can search. */
  isValid: boolean
  /** Why a name was refused, when there is more to say than "not a domain". */
  problem?: { kind: 'mixed-script'; scripts: string[] }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** A label is usable when it is valid ASCII and, if it is an `xn--` label, a real encoding. */
function isUsableLabel(label: string): boolean {
  if (!LABEL.test(label)) return false
  const unicode = toUnicodeLabel(label)
  // `-café` encodes to a tidy `xn---caf-epa`, but a hyphen may not start the name people see.
  return unicode !== null && !unicode.startsWith('-') && !unicode.endsWith('-')
}

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

  // FR-S8: `café.com` is searched as `xn--caf-dma.com`.
  const ascii = toAsciiHost(cleaned)
  if (!ascii) return { stem: '', tld: null, isValid: false }

  const parts = ascii.split('.').filter(Boolean)
  const stem = parts[0] ?? ''

  if (!isUsableLabel(stem)) return { stem, tld: null, isValid: false }

  // FR-S8: a name mixing lookalike alphabets is how homograph attacks are made.
  const scripts = mixedScripts(toUnicodeLabel(stem) ?? stem)
  if (scripts) {
    return { stem, tld: null, isValid: false, problem: { kind: 'mixed-script', scripts } }
  }

  // Multi-label extensions such as `com.ng` must survive intact.
  const tld = parts.length > 1 ? parts.slice(1).join('.') : null
  if (tld && !tld.split('.').every(isUsableLabel)) {
    return { stem, tld: null, isValid: false }
  }

  return { stem, tld, isValid: true }
}

/** The name as people read it — Unicode for an international name, unchanged otherwise. */
export function displayQuery({ stem, tld }: Pick<ParsedQuery, 'stem' | 'tld'>): string {
  return toUnicodeHost(tld ? `${stem}.${tld}` : stem)
}

/** Plain words for why a name was refused (FR-S8 asks for a clear explanation). */
export function describeProblem(problem: NonNullable<ParsedQuery['problem']>): string {
  const scripts = problem.scripts.join(' and ')
  return `This name mixes letters from different alphabets (${scripts}). Names like that are used to imitate other websites, so we don't sell them. Type it in one alphabet.`
}

/**
 * Builds the canonical search URL so every entry point agrees on the shape.
 * It carries the readable form: `?q=café.com`, not `?q=xn--caf-dma.com`.
 */
export function searchHref(raw: string): string {
  const parsed = parseSearchQuery(raw)
  if (!parsed.isValid) return '/search'
  return `/search?q=${encodeURIComponent(displayQuery(parsed))}`
}
