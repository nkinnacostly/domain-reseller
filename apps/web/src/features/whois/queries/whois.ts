import 'server-only'

import { cacheLife } from 'next/cache'
import { lookupRdap } from '@/features/transfers/queries/rdap-lookup'
import { logger } from '@/lib/logger'
import { parseWhoisRecord, type WhoisLookup } from '../lib/whois'

export type WhoisAnswer = {
  lookup: WhoisLookup
  /** When the registry was asked. Null when it gave no usable answer. */
  checkedAt: string | null
}

/**
 * Kept for 15 minutes, as ADR-003 sets for public lookups: the same name
 * looked up again does not ask the registry again. "The registry did not
 * answer" throws instead of returning, because a throw is never cached — the
 * next person gets a fresh try, not a quarter of an hour of failure.
 */
async function cachedLookup(domain: string): Promise<{ lookup: WhoisLookup; checkedAt: string }> {
  'use cache'
  cacheLife({ stale: 60, revalidate: 900, expire: 900 })

  const lookup = await lookupRdap(domain, parseWhoisRecord)
  if (lookup.kind === 'unavailable') throw new Error('registry gave no usable answer')
  return { lookup, checkedAt: new Date().toISOString() }
}

export async function lookupWhois(domain: string): Promise<WhoisAnswer> {
  try {
    return await cachedLookup(domain)
  } catch {
    // The extension, never the name: a looked-up name is as private as a
    // search (FR-S7). The lookup itself has already logged the cause, and a
    // production build hides the thrown message anyway.
    logger.warn({ tld: domain.slice(domain.indexOf('.') + 1) }, 'whois lookup unavailable')
    return { lookup: { kind: 'unavailable' }, checkedAt: null }
  }
}
