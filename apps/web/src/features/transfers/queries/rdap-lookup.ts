import 'server-only'

import { cacheLife, cacheTag } from 'next/cache'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import {
  parseBootstrap,
  parseRdapDomain,
  type RdapBootstrap,
  type RdapLookup,
  type RdapRecord,
  rdapBaseFor,
  rdapDomainUrl,
} from '../lib/rdap'

/** IANA's registry of which server answers for which TLD (RFC 9224). */
export const IANA_RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

/**
 * Where lookups start: IANA, unless RDAP_BOOTSTRAP_URL points them at the e2e
 * mock registry. Read here and nowhere else. Unset only where env validation
 * is skipped (unit tests), when IANA applies.
 */
function bootstrapUrl(): string {
  return env.RDAP_BOOTSTRAP_URL ?? IANA_RDAP_BOOTSTRAP_URL
}

/**
 * Registries answer in well under a second (Verisign ~0.4s, PIR ~0.8s,
 * .africa ~1.1s when measured). Past this, the person is better served by
 * "the registry did not answer" than by a spinner.
 */
const LOOKUP_TIMEOUT_MS = 6_000

/**
 * IANA publishes the bootstrap file a few times a month, so a day's cache is
 * plenty. A failed fetch throws, and a throw is never cached — the next
 * request tries again rather than serving a day of "unavailable".
 */
export async function getRdapBootstrap(): Promise<RdapBootstrap> {
  'use cache'
  cacheTag('rdap-bootstrap')
  cacheLife('days')

  const response = await fetch(bootstrapUrl(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`RDAP bootstrap returned ${response.status}`)
  return parseBootstrap(await response.json())
}

/**
 * Looks a domain up at its registry. Deliberately uncached: someone who has
 * just switched their lock off and checks again must see the new state, not
 * one from a minute ago.
 */
export async function lookupDomain(domain: string): Promise<RdapLookup> {
  return lookupRdap<RdapRecord>(domain, parseRdapDomain)
}

/**
 * The lookup itself, reading whatever `parse` takes from a found record (null:
 * not a record we can read). Never logs the name — which registry misbehaved
 * is what operations needs, and a looked-up name is as private as a search
 * (FR-S7).
 */
export async function lookupRdap<T>(
  domain: string,
  parse: (json: unknown) => T | null,
): Promise<RdapLookup<T>> {
  const tld = domain.slice(domain.indexOf('.') + 1)

  let bootstrap: RdapBootstrap
  try {
    bootstrap = await getRdapBootstrap()
  } catch (err) {
    logger.warn({ err, step: 'bootstrap' }, 'rdap lookup failed')
    return { kind: 'unavailable' }
  }

  const base = rdapBaseFor(bootstrap, domain)
  if (!base) return { kind: 'unsupported' }

  try {
    const response = await fetch(rdapDomainUrl(base, domain), {
      headers: { accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      cache: 'no-store',
    })

    if (response.status === 404) return { kind: 'not-found' }
    if (!response.ok) {
      logger.warn({ tld, status: response.status }, 'rdap lookup failed')
      return { kind: 'unavailable' }
    }

    const record = parse(await response.json())
    return record ? { kind: 'found', record } : { kind: 'unavailable' }
  } catch (err) {
    logger.warn({ err, tld }, 'rdap lookup failed')
    return { kind: 'unavailable' }
  }
}
