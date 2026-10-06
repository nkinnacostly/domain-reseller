import { fromBase64, toBase64 } from '../ses/base64'
import { randomBytes, subtle, utf8 } from '../ses/platform'

/**
 * Standard Webhooks (https://www.standardwebhooks.com): the scheme Supabase
 * Auth's hooks sign with — verified by the shop's /api/auth/send-email — and
 * the one Mail signs its customers' webhooks with (MAIL-SPEC MR6).
 *
 * The secret is `whsec_<base64>` (Supabase writes `v1,whsec_<base64>`). The
 * signature is `v1,<base64 HMAC-SHA256>` over `id.timestamp.body`, and a
 * header may carry several, space-separated, while a secret rotates. A
 * timestamp more than five minutes off is refused, so a captured request
 * cannot be replayed later. Web Crypto only: it runs on Vercel and in the
 * mail worker alike, and compares in constant time (`subtle.verify`).
 */

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

export type WebhookHeaders = {
  id: string | null
  timestamp: string | null
  signature: string | null
}

/** The key bytes of `whsec_…` or `v1,whsec_…`; null when there are none. */
export function webhookKey(secret: string): Uint8Array | null {
  const key = fromBase64(secret.replace(/^v1,/, '').replace(/^whsec_/, ''))
  return key && key.length > 0 ? key : null
}

const content = (id: string, timestamp: string, body: string) => utf8(`${id}.${timestamp}.${body}`)

/** `v1,<base64>` for this message. */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = webhookKey(secret)
  if (!key) throw new Error('webhook secret has no key')
  const hmac = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return `v1,${toBase64(new Uint8Array(await subtle().sign('HMAC', hmac, content(id, timestamp, body))))}`
}

/** The three headers a signed delivery carries. */
export async function webhookHeaders(
  secret: string,
  id: string,
  body: string,
  now: Date = new Date(),
): Promise<Record<'webhook-id' | 'webhook-timestamp' | 'webhook-signature', string>> {
  const timestamp = String(Math.floor(now.getTime() / 1000))
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': await signWebhook(secret, id, timestamp, body),
  }
}

export async function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false
  const key = webhookKey(secret)
  if (!key) return false
  const hmac = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ])
  const data = content(id, timestamp, body)
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',', 2)
    if (version !== 'v1' || !value) continue
    const given = fromBase64(value)
    if (given && (await subtle().verify('HMAC', hmac, given, data))) return true
  }
  return false
}

/** A new signing secret for a customer's endpoint, shown once (§10). */
export function newWebhookSecret(): string {
  return `whsec_${toBase64(randomBytes(24))}`
}
