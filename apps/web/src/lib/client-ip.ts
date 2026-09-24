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
  const ip =
    headers.get('x-real-ip')?.trim() ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'

  return createHmac('sha256', env.SUPABASE_SECRET_KEY ?? 'unkeyed')
    .update(ip)
    .digest('hex')
    .slice(0, 32)
}
