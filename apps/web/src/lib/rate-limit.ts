import 'server-only'

import { headers } from 'next/headers'
import { clientKey } from '@/lib/client-ip'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Per-account limits on the payment path (SEC-11, PRD R15), and per-address
 * limits on public lookups (FR-PUB2, keyed by lib/client-ip.ts). Counted in
 * Postgres, so every serverless instance and region sees the same count.
 *
 * Fails closed: if the count cannot be read, the action is refused. For
 * something that moves money, "try again in a moment" beats unmetered.
 */
export const LIMITS = {
  // Each attempt re-checks availability and the float with the supplier and
  // opens a Flutterwave payment: generous for a person, tight for a script.
  placeOrder: { max: 10, windowSeconds: 600 },
  placeOrderDaily: { max: 40, windowSeconds: 86_400 },
  // Each return re-reads a transaction from Flutterwave: per order, and per
  // account so many small orders cannot be used to multiply the calls.
  checkoutReturn: { max: 30, windowSeconds: 600 },
  checkoutReturnAccount: { max: 60, windowSeconds: 600 },
  // Webhooks carry our shared secret, so these only bite if it leaks or
  // Flutterwave misbehaves: one charge is not settled a hundred times over.
  webhookPerCharge: { max: 20, windowSeconds: 600 },
  webhookAll: { max: 600, windowSeconds: 60 },
  // Anyone may ask for a price refresh; it only acts when prices really changed.
  pricingRefresh: { max: 12, windowSeconds: 3600 },
  // A WHOIS lookup asks a registry, and registries limit us by our server's
  // address (FR-PUB2). Per person: plenty for checking a few names. In total:
  // so one scraper cannot get our lookups — transfer checks included — refused.
  whoisLookup: { max: 30, windowSeconds: 600 },
  whoisAll: { max: 600, windowSeconds: 600 },
  // FR-S5 — per address, counted per block (one gateway request and one
  // supplier call of at most 20 checks), so the count follows the checks
  // made, not the searches run. The largest list — 500 names on all seven
  // extensions — is 175 blocks, so one full list fits in ten minutes and a
  // second does not. The supplier allows two calls at a time for everyone
  // (PRD V4), and the gateway lets bulk use one.
  bulkSearch: { max: 180, windowSeconds: 600 },
  // Adding every available name re-checks them all with the registry first.
  bulkAddToCart: { max: 20, windowSeconds: 600 },
  // FR-P4 — one bulk change can queue a registry job for each of 500
  // domains. A person makes a few in a sitting; a script would flood the queue.
  bulkChange: { max: 20, windowSeconds: 600 },
  // A transfer check confirms or denies a code (FR-T1). Counted per domain, so
  // many accounts cannot share out guesses at someone else's.
  transferCheckDomain: { max: 10, windowSeconds: 3600 },
} as const

/**
 * A limit key for the caller's address, for public actions that have no
 * account to count against. The address is hashed, so the table never holds
 * it as written.
 */
export async function addressKey(scope: string): Promise<string> {
  return `${scope}:${clientKey(await headers())}`
}

export async function withinLimit(
  key: string,
  limit: { max: number; windowSeconds: number },
): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('rate_limit_hit', {
    p_key: key,
    p_max: limit.max,
    p_window_seconds: limit.windowSeconds,
  })
  if (error) {
    logger.error({ err: error.message }, 'rate limit could not be checked; refusing')
    return false
  }
  return data === true
}
