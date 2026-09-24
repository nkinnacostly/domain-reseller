import { parseTransferQuery, type TransferQuery } from '@/features/transfers/lib/href'
import {
  parseRdapDomain,
  parseRdapNameservers,
  type RdapLookup,
  type RdapRecord,
} from '@/features/transfers/lib/rdap'

/**
 * The public WHOIS lookup (PRD FR-PUB2, ADR-003), built on the transfer
 * check's RDAP client.
 *
 * What it shows is deliberately narrow: registrar, dates, status codes and
 * nameservers. Registries now withhold owners' details, and we never show
 * them even when one publishes them — nothing about a person is parsed, so
 * nothing about a person can reach the page.
 */
export type WhoisRecord = RdapRecord & { nameservers: string[] }

export type WhoisLookup = RdapLookup<WhoisRecord>

/** Null when the answer is not a domain record we can read. */
export function parseWhoisRecord(json: unknown): WhoisRecord | null {
  const record = parseRdapDomain(json)
  return record ? { ...record, nameservers: parseRdapNameservers(json) } : null
}

/** Same tolerance as search and the transfer check: URLs, `www.` and capitals are cleaned up. */
export function parseWhoisQuery(raw: string): TransferQuery {
  return parseTransferQuery(raw)
}

export const WHOIS_QUERY_MESSAGES = {
  empty: 'Type the domain you want to look up',
  invalid: 'Use letters, numbers and hyphens — for example getpaid.com',
  'no-extension': 'Include the extension — for example getpaid.com, not just getpaid',
} as const

/** Canonical URL for a lookup, so the form and every link agree on its shape. */
export function whoisHref(domain: string): string {
  return `/whois?domain=${encodeURIComponent(domain)}#result`
}

/**
 * What each registry status means, in plain words (RFC 8056 names, as
 * normaliseStatus writes them). A status we have no words for is shown as the
 * registry wrote it, without a gloss.
 */
const STATUS_MEANING: Record<string, string> = {
  active: 'Registered and working, with nothing pending.',
  ok: 'Registered and working, with nothing pending.',
  inactive: 'It has no nameservers, so it does not lead anywhere yet.',
  'client transfer prohibited':
    'Its registrar has locked it against transfers — the usual protection against theft.',
  'server transfer prohibited': 'The registry has locked it against transfers.',
  'client delete prohibited': 'Its registrar will not let it be deleted.',
  'server delete prohibited': 'The registry will not let it be deleted.',
  'client update prohibited': 'Its registrar will not let its details be changed.',
  'server update prohibited': 'The registry will not let its details be changed.',
  'client renew prohibited': 'Its registrar will not let it be renewed.',
  'server renew prohibited': 'The registry will not let it be renewed.',
  'client hold': 'Its registrar has switched it off, so it does not resolve.',
  'server hold': 'The registry has switched it off, so it does not resolve.',
  'pending create': 'It is being registered.',
  'pending delete': 'The registry is deleting it.',
  'pending renew': 'A renewal is being processed.',
  'pending restore': 'It is being restored after expiring.',
  'pending transfer': 'It is moving to another registrar.',
  'pending update': 'A change to it is being processed.',
  'add period': 'It was registered in the last few days.',
  'auto renew period': 'It was renewed automatically in the last few weeks.',
  'renew period': 'It was renewed in the last few days.',
  'transfer period': 'It moved to its current registrar in the last few days.',
  'redemption period':
    'It has expired. Its owner can still restore it, at a cost, before it is deleted.',
}

export function describeStatus(status: string): string | null {
  return STATUS_MEANING[status] ?? null
}

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
})

const timeFormat = new Intl.DateTimeFormat('en-NG', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Africa/Lagos',
})

export function formatWhoisDate(iso: string): string {
  return dateFormat.format(new Date(iso))
}

/** "14:05 on 24 September 2026", Lagos time. */
export function formatCheckedAt(iso: string): string {
  const at = new Date(iso)
  return `${timeFormat.format(at)} on ${dateFormat.format(at)}`
}

export type WhoisHeadline = { title: string; summary: string }

/** The one-line answer at the top of a found record. `now` is passed so it is testable. */
export function registeredHeadline(domain: string, record: WhoisRecord, now: Date): WhoisHeadline {
  const has = (status: string) => record.statuses.includes(status)
  const through = record.registrar ? ` through ${record.registrar}` : ''

  if (has('pending delete')) {
    return {
      title: `${domain} is being deleted`,
      summary: 'The registry is deleting it. Once it is released, it can be registered again.',
    }
  }
  if (has('redemption period') || has('pending restore')) {
    return {
      title: `${domain} has expired`,
      summary: 'It is in the redemption period: its owner can still restore it, at a cost.',
    }
  }
  if (record.expiresAt && new Date(record.expiresAt) < now) {
    return {
      title: `${domain} has expired`,
      summary: `Its expiry date has passed, but it is still registered${through}. Owners can usually renew for a while after expiry.`,
    }
  }
  return {
    title: `${domain} is registered`,
    summary: record.expiresAt
      ? `It is registered${through} until ${formatWhoisDate(record.expiresAt)}.`
      : `It is registered${through}.`,
  }
}
