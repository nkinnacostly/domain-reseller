import { parseSearchQuery } from '@/features/search/lib/query'

/** The domain a transfer check is about, or why there isn't one. */
export type TransferQuery =
  | { ok: true; domain: string; tld: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'no-extension' }

/** Same tolerance as search: URLs, `www.`, capitals and spaces are cleaned up. */
export function parseTransferQuery(raw: string): TransferQuery {
  if (!raw.trim()) return { ok: false, reason: 'empty' }

  const { stem, tld, isValid } = parseSearchQuery(raw)
  if (!isValid) return { ok: false, reason: 'invalid' }
  if (!tld) return { ok: false, reason: 'no-extension' }

  return { ok: true, domain: `${stem}.${tld}`, tld }
}

export const TRANSFER_QUERY_MESSAGES = {
  empty: 'Type the domain you want to move here',
  invalid: 'Use letters, numbers and hyphens — for example getpaid.com',
  'no-extension': 'Include the extension — for example getpaid.com, not just getpaid',
} as const

/** Canonical URL for a check, so every entry point agrees on its shape. */
export function transferCheckHref(domain: string): string {
  return `/transfer?domain=${encodeURIComponent(domain)}#check`
}

/** Where a transfer is started and paid for (FR-T2). Signed in: the proxy asks first. */
export function transferStartHref(domain: string): string {
  return `/app/transfers/new?domain=${encodeURIComponent(domain)}`
}
