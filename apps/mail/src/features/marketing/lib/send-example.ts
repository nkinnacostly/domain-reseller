import { API_KEY_PREFIX } from '@dr/shared/mail'
import { BUSINESS } from '@/lib/business'

/**
 * The one call the home page shows: `POST /api/v1/emails` (MAIL-SPEC §1,
 * §6). The body is a real request — a test holds it to `sendEmailSchema`,
 * the schema the API validates with — so the example can never drift from
 * what the API accepts.
 */
export const EXAMPLE_EMAIL = {
  from: 'Acme <receipts@acme.ng>',
  to: ['ada@example.com'],
  subject: 'Your receipt',
  html: '<p>Thanks for your order.</p>',
}

export const EXAMPLE_IDEMPOTENCY_KEY = 'order-1042-receipt'

/** What the API answers once the email is queued: its id. */
export const EXAMPLE_RESPONSE = { id: '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d' }

export const SEND_PATH = '/emails'

/** The curl command, as a person would paste it. The key is elided, never a real one. */
export function curlExample(): string {
  const body = JSON.stringify(EXAMPLE_EMAIL, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n')
  return [
    `curl -X POST ${BUSINESS.apiBase}${SEND_PATH} \\`,
    `  -H "Authorization: Bearer ${API_KEY_PREFIX}…" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -H "Idempotency-Key: ${EXAMPLE_IDEMPOTENCY_KEY}" \\`,
    `  -d '${body}'`,
  ].join('\n')
}

export const responseExample = (): string => JSON.stringify(EXAMPLE_RESPONSE)
