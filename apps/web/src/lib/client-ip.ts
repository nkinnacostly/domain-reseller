import 'server-only'

import { createHmac } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * A rate-limit key for whoever sent this request, for public pages that have
 * no account to count against (PRD FR-PUB2).
 *
 * The address comes from the platform: Vercel sets `x-real-ip` and overwrites
 * `x-forwarded-for` with the client's address, so neither can be spoofed
 * there. Everyone the platform cannot tell apart shares one bucket.
 *
 * Keyed-hashed, never kept raw: an IP address is personal data under the NDPA,
 * and a plain hash of an IPv4 address is undone by trying all four billion.
 * The key is the server's secret key, which never leaves the server.
 */
export function clientKey(headers: Headers): string {
  return createHmac('sha256', env.SUPABASE_SECRET_KEY ?? 'unkeyed')
    .update(clientAddress(headers) ?? 'unknown')
    .digest('hex')
    .slice(0, 32)
}

/**
 * The caller's address as the platform reports it, or undefined. Only for
 * handing to a service that needs it for this one request — Turnstile's
 * `remoteip` (SEC-9) — never for storing or logging (NDPA).
 */
export function clientAddress(headers: Headers): string | undefined {
  return (
    headers.get('x-real-ip')?.trim() ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    undefined
  )
}
