import type { ApiErrorName } from '@dr/shared/mail'
import { BUSINESS } from '@/lib/business'
import { API_KEY_ENV } from './samples'

/**
 * The "Switching from Resend" guide's facts (/docs/resend). Every SDK call
 * listed as working is one `resend-sdk.test.ts` runs against our route
 * handlers, with the SDK at this version — a test holds the number to the
 * one installed, so the page cannot name a version nobody tested (N9b).
 * The error names on the left are the SDK's own type (`ErrorResponse`).
 */

export const RESEND_SDK_TESTED = '6.32.1'

export function resendEnvExample(): string {
  return [`RESEND_API_KEY=mdh_live_…`, `RESEND_BASE_URL=${BUSINESS.apiBase}`].join('\n')
}

export function resendCodeExample(): string {
  return [
    "import { Resend } from 'resend'",
    '',
    `const resend = new Resend(process.env.${API_KEY_ENV}, {`,
    `  baseUrl: '${BUSINESS.apiBase}',`,
    '})',
    '',
    'const { data, error } = await resend.emails.send({',
    "  from: 'Acme <receipts@acme.ng>',",
    "  to: 'ada@example.com',",
    "  subject: 'Your receipt',",
    "  html: '<p>Thanks for your order.</p>',",
    '})',
  ].join('\n')
}

/** What each tested call does here. */
export const RESEND_CALLS: readonly { call: string; here: string }[] = [
  {
    call: 'emails.send',
    here: 'Every field the SDK sends: from, to, cc, bcc, replyTo, subject, html, text, headers, tags, scheduledAt and attachments — content as a Buffer or base64, contentType, and contentId for inline images — and the idempotencyKey option.',
  },
  { call: 'batch.send', here: 'Up to 100 emails, queued all together or not at all.' },
  { call: 'emails.get', here: 'The email, its status and its latest event.' },
  { call: 'emails.list', here: 'The newest first, with limit.' },
  { call: 'emails.update', here: 'Moves an email still waiting to its new scheduledAt.' },
  { call: 'emails.cancel', here: 'Cancels an email still waiting.' },
  { call: 'domains.list, domains.get', here: 'Your domains and their status.' },
  {
    call: 'webhooks.verify',
    here: 'Checks our webhook deliveries with your endpoint’s signing secret. Our email events are email.sent, email.delivered, email.delivery_delayed, email.bounced, email.complained and email.failed; the webhooks guide shows the payload.',
  },
]

/** Where the API answers differently, and what to do. */
export const RESEND_DIFFERENCES: readonly { what: string; here: string }[] = [
  {
    what: 'scheduledAt',
    here: 'An ISO 8601 date and time with its zone, at most 72 hours ahead. Words like “in 1 hour” are refused.',
  },
  { what: 'Attachments by URL (path)', here: 'Not supported: send the file itself in content.' },
  {
    what: 'batch.send with batchValidation: permissive',
    here: 'Refused. A batch is queued whole or not at all — the SDK’s default.',
  },
  {
    what: 'emails.list with after or before',
    here: 'Refused. Ask for a larger limit, or page with the HTTP API’s cursor.',
  },
  {
    what: 'Custom headers',
    here: 'X-* (but not X-SES-*), List-Unsubscribe, List-Unsubscribe-Post, List-Id, In-Reply-To, References and Auto-Submitted.',
  },
  {
    what: 'Templates, contacts, segments, broadcasts, topics, receiving',
    here: 'Not offered. A call to one answers not_found or validation_error.',
  },
  { what: 'Open and click tracking', here: 'Not offered.' },
  {
    what: 'A new account',
    here: 'Starts in the sandbox, sending only to its own team, until we have approved it.',
  },
]

/** The SDK's error names, and ours. */
export const RESEND_ERROR_NAMES: readonly { theirs: string[]; ours: ApiErrorName[] }[] = [
  { theirs: ['missing_api_key', 'invalid_api_key'], ours: ['unauthorized'] },
  { theirs: ['restricted_api_key', 'invalid_access'], ours: ['forbidden'] },
  { theirs: ['invalid_from_address'], ours: ['domain_not_verified', 'validation_error'] },
  {
    theirs: [
      'validation_error',
      'missing_required_field',
      'invalid_parameter',
      'invalid_attachment',
      'invalid_idempotency_key',
      'invalid_idempotent_request',
    ],
    ours: ['validation_error'],
  },
  { theirs: ['rate_limit_exceeded'], ours: ['rate_limited'] },
  { theirs: ['daily_quota_exceeded', 'monthly_quota_exceeded'], ours: ['quota_exceeded'] },
  { theirs: ['not_found'], ours: ['not_found'] },
  { theirs: ['application_error', 'internal_server_error'], ours: ['internal_error'] },
]
