import { domainToASCII, domainToUnicode } from 'node:url'

/**
 * A domain as typed — `Acme.NG.`, `https://acme.ng/`, `café.ng` — as DNS and
 * SES hold it: lower-case ASCII, punycode for an international name (as the
 * shop does, FR-S8), no scheme, path or trailing dot. Null when it cannot be
 * a domain. SQL checks the result again (`domain_name_ok`, migration 47).
 * Server-side: node:url does the punycode.
 */

const DOMAIN = /^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

export function normaliseDomain(input: string): string | null {
  let value = input.trim().toLowerCase()
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.split(/[/?#]/)[0] ?? ''
  value = value.replace(/\.+$/, '')
  if (value === '' || /[\s@*]/.test(value)) return null
  // Plain ASCII never goes through the URL parser (CLAUDE.md §15: `123` became `0.0.0.123`).
  const ascii = /^[\x21-\x7e]+$/.test(value) ? value : domainToASCII(value)
  return ascii && DOMAIN.test(ascii) ? ascii : null
}

/** mydomainshub.com and every name under it are ours (§5). */
export const isReservedDomain = (name: string): boolean => /(^|\.)mydomainshub\.com$/.test(name)

/** `xn--caf-dma.ng` as people read it, `café.ng`; null when it is plain ASCII already. */
export function unicodeOf(ascii: string): string | null {
  if (!ascii.split('.').some((label) => label.startsWith('xn--'))) return null
  const unicode = domainToUnicode(ascii)
  return unicode && unicode !== ascii ? unicode : null
}
