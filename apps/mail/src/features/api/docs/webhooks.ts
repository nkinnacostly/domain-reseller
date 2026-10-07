import {
  WEBHOOK_EVENTS,
  WEBHOOK_PORTS,
  WEBHOOK_TIMEOUT_SECONDS,
  WEBHOOK_USER_AGENT,
  type WebhookEvent,
} from '@dr/shared/mail'
import { EXAMPLE_EMAIL, EXAMPLE_RESPONSE } from '@/features/marketing/lib/send-example'

/**
 * The webhooks guide's facts and samples (MAIL-SPEC §6, MR6), each taken
 * from what the code does: the payload is migration 49's `{ type,
 * created_at, data }` and never a body (MR3); the request is the mail
 * worker's (Standard Webhooks headers, signed by `@dr/shared/webhooks`); the
 * retries are `record_webhook_attempt`'s. A test signs the worked example
 * with `signWebhook` and runs the Node sample against it, so the guide cannot
 * drift from the signer.
 */

export const WEBHOOK_SECRET_ENV = 'MDH_WEBHOOK_SECRET'

/**
 * A secret for the worked example only — the words "MyDomainsHub example
 * key", base64 — never one we issued. A real one is shown once, when the
 * endpoint is made or its secret rotated.
 */
export const EXAMPLE_WEBHOOK_SECRET = 'whsec_TXlEb21haW5zSHViIGV4YW1wbGUga2V5'
export const EXAMPLE_WEBHOOK_ID = 'msg_2f6c1e0b9a8d4c7e8f1a2b3c4d5e6f70'
/** 2026-10-07T09:00:05Z. */
export const EXAMPLE_WEBHOOK_TIMESTAMP = '1791363605'
/** What `signWebhook` makes of the three above and EXAMPLE_WEBHOOK_BODY; a test holds it so. */
export const EXAMPLE_WEBHOOK_SIGNATURE = 'v1,h9l5IZCd5qvgeyFOrxXqaO5bfylqYxNOyrE+DulGTUE='

/**
 * The payload is jsonb, and Postgres keeps an object's keys shortest first,
 * then in byte order: the body arrives in that order, which is one more
 * reason to check the bytes you received rather than JSON you re-made.
 */
export function inJsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inJsonbOrder)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, inJsonbOrder(inner)]),
    )
  }
  return value
}

/** One email.delivered, as `email_webhook_data` builds it for the home page's example email. */
export const EXAMPLE_WEBHOOK_PAYLOAD = inJsonbOrder({
  type: 'email.delivered',
  created_at: '2026-10-07T09:00:04.512Z',
  data: {
    email_id: EXAMPLE_RESPONSE.id,
    from: EXAMPLE_EMAIL.from,
    to: EXAMPLE_EMAIL.to,
    subject: EXAMPLE_EMAIL.subject,
    tags: [{ name: 'order', value: '1042' }],
    created_at: '2026-10-07T09:00:01.208Z',
  },
}) as Record<string, unknown>

/** The body exactly as the worker sends it: `JSON.stringify` of the payload, no spaces. */
export const EXAMPLE_WEBHOOK_BODY = JSON.stringify(EXAMPLE_WEBHOOK_PAYLOAD)

/** The request as it reaches your server, on the wire. */
export function rawWebhookRequest(): string {
  return [
    'POST /hooks/mydomainshub HTTP/1.1',
    'Host: hooks.acme.ng',
    `webhook-id: ${EXAMPLE_WEBHOOK_ID}`,
    `webhook-timestamp: ${EXAMPLE_WEBHOOK_TIMESTAMP}`,
    `webhook-signature: ${EXAMPLE_WEBHOOK_SIGNATURE}`,
    'content-type: application/json',
    `user-agent: ${WEBHOOK_USER_AGENT}`,
    `content-length: ${new TextEncoder().encode(EXAMPLE_WEBHOOK_BODY).length}`,
    '',
    EXAMPLE_WEBHOOK_BODY,
  ].join('\n')
}

/** The content that is signed, for the worked example. */
export const exampleSignedContent = (): string =>
  `${EXAMPLE_WEBHOOK_ID}.${EXAMPLE_WEBHOOK_TIMESTAMP}.${EXAMPLE_WEBHOOK_BODY}`

/**
 * The check itself, in Node, as `verifyWebhook` in `@dr/shared/webhooks`
 * does it: the key is the secret after `whsec_`, base64-decoded; the
 * signature is HMAC-SHA256 over `id.timestamp.body`, base64, after `v1,`;
 * several may be given, separated by spaces; a timestamp more than five
 * minutes from now is refused. A test runs this very text.
 */
export const NODE_VERIFY_FUNCTION = `function verifyWebhook(secret, headers, body, now = Date.now()) {
  const id = headers['webhook-id']
  const timestamp = headers['webhook-timestamp']
  const signatures = headers['webhook-signature']
  if (!id || !timestamp || !signatures || !/^\\d+$/.test(timestamp)) return false
  // More than five minutes from your clock: refuse it, so a copied request cannot be replayed.
  if (Math.abs(now / 1000 - Number(timestamp)) > 5 * 60) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(\`\${id}.\${timestamp}.\${body}\`).digest()
  // The header can carry several signatures, separated by spaces: one match is enough.
  return signatures.split(' ').some((signature) => {
    const [version, value] = signature.split(',')
    const given = Buffer.from(value ?? '', 'base64')
    return version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected)
  })
}`

export const NODE_IMPORTS = [
  "import { createHmac, timingSafeEqual } from 'node:crypto'",
  "import { createServer } from 'node:http'",
].join('\n')

/** A whole receiver: read the raw body, check it, act once per webhook-id, answer 2xx. */
export function nodeReceiverExample(): string {
  return [
    '// Node 18 or later, no packages needed.',
    NODE_IMPORTS,
    '',
    NODE_VERIFY_FUNCTION,
    '',
    'const handled = new Set() // in production, a table keyed by webhook-id',
    '',
    'createServer(async (request, response) => {',
    '  // The raw body, byte for byte: JSON parsed and re-made would not match the signature.',
    '  const chunks = []',
    '  for await (const chunk of request) chunks.push(chunk)',
    "  const body = Buffer.concat(chunks).toString('utf8')",
    `  if (!verifyWebhook(process.env.${WEBHOOK_SECRET_ENV}, request.headers, body)) {`,
    '    response.writeHead(401).end()',
    '    return',
    '  }',
    '  // A retry or a resend carries the same webhook-id: act on each one once.',
    "  const id = request.headers['webhook-id']",
    '  if (!handled.has(id)) {',
    '    handled.add(id)',
    '    const event = JSON.parse(body)',
    '    console.log(event.type, event.data.email_id ?? event.data.domain_id)',
    '  }',
    `  response.writeHead(204).end() // any 2xx, within ${WEBHOOK_TIMEOUT_SECONDS} seconds`,
    '}).listen(3000)',
  ].join('\n')
}

/** What each event means, and what `data` carries beyond the email's own fields. */
export const WEBHOOK_EVENT_DOCS: Record<WebhookEvent, { when: string; extra: string | null }> = {
  'email.sent': { when: 'Amazon SES accepted the email for delivery.', extra: null },
  'email.delivered': { when: 'The recipient’s mail server accepted it.', extra: null },
  'email.delivery_delayed': {
    when: 'A temporary problem on the way; SES keeps trying.',
    extra: 'delay.type, when SES names one',
  },
  'email.bounced': {
    when: 'The recipient’s mail server turned it away. A permanent bounce puts the address on your suppression list.',
    extra: 'bounce.type, bounce.sub_type and bounce.diagnostic, when SES gives them',
  },
  'email.complained': {
    when: 'A recipient reported it as spam. The address goes on your suppression list.',
    extra: 'complaint.type and complaint.sub_type, when SES gives them',
  },
  'email.failed': {
    when: 'It was not sent: refused when it was due to go, refused by SES, or given up.',
    extra: 'reason, the same code as the email’s status_reason',
  },
  'domain.verified': { when: 'A domain is verified and ready to send from.', extra: null },
  'domain.failed': {
    when: 'A domain’s records were not found in time, or SES could not set it up.',
    extra: null,
  },
}

/** The events in the order the guide lists them: every one there is. */
export const WEBHOOK_EVENT_ORDER: readonly WebhookEvent[] = WEBHOOK_EVENTS

/** "443 or 8443", for the words. */
export const WEBHOOK_PORT_WORDS = WEBHOOK_PORTS.join(' or ')
