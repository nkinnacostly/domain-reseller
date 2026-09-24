import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies a Standard Webhooks signature (https://www.standardwebhooks.com),
 * the scheme Supabase Auth hooks sign with. The secret is `v1,whsec_<base64>`;
 * the signature is `v1,<base64 HMAC-SHA256>` over `id.timestamp.body`, and a
 * header may carry several, space-separated, while a secret rotates. A
 * timestamp more than five minutes off is refused, so a captured request
 * cannot be replayed later.
 */

const TOLERANCE_SECONDS = 5 * 60

export type WebhookHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

export function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  now: Date = new Date(),
): boolean {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false

  const key = Buffer.from(secret.replace(/^v1,/, '').replace(/^whsec_/, ''), 'base64')
  if (key.length === 0) return false
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()

  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',', 2)
    if (version !== 'v1' || !value) return false
    const given = Buffer.from(value, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
