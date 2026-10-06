import { z } from 'zod'
import { fromBase64, toBase64 } from '../ses/base64'
import { utf8 } from '../ses/platform'
import { EMAIL_LIMITS, timestampSchema, toUtc } from './api'
import { EMAIL_STATUSES, type EmailStatus, SEND_EVENTS } from './status'

/**
 * The v1 API's other inputs and every answer (MAIL-SPEC §6): listing,
 * rescheduling and cancelling emails, and API keys. The OpenAPI document
 * (`openapi.ts`) and the docs' reference are generated from these, and the
 * handlers parse SQL's answers with them — one shape, three uses, no drift.
 */

// ── Listing emails: GET /emails ─────────────────────────────────────────────

const tagFilter = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,256}(:[A-Za-z0-9_-]{1,256})?$/, 'A tag name, or name:value')

export const listEmailsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(EMAIL_LIMITS.maxPage)
    .optional()
    .describe(
      `How many to answer, 1 to ${EMAIL_LIMITS.maxPage}. ${EMAIL_LIMITS.defaultPage} unless given.`,
    ),
  cursor: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe('The `next_cursor` of the page before, as it was given, for the next (older) page.'),
  status: z.enum(EMAIL_STATUSES).optional().describe('Only emails with this status.'),
  to: z
    .email()
    .transform((address) => address.toLowerCase())
    .optional()
    .describe('Only emails to exactly this address, in to, cc or bcc.'),
  tag: tagFilter.optional().describe('Only emails with this tag name, or this name:value pair.'),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Only emails whose subject contains this text, in any case.'),
  created_after: timestampSchema
    .optional()
    .describe('Only emails queued at or after this moment (ISO 8601 with its zone).'),
  created_before: timestampSchema
    .optional()
    .describe('Only emails queued before this moment (ISO 8601 with its zone).'),
})

export type ListEmailsQuery = z.output<typeof listEmailsQuerySchema>

/**
 * The query string as the schema reads it. A parameter given twice is a
 * mistake we refuse rather than guess which one was meant.
 */
export function readQuery(
  params: Iterable<[string, string]>,
): { ok: true; query: Record<string, string> } | { ok: false; repeated: string } {
  const query: Record<string, string> = {}
  for (const [key, value] of params) {
    if (Object.hasOwn(query, key)) return { ok: false, repeated: key }
    query[key] = value
  }
  return { ok: true, query }
}

/** The filters the log takes — the API's query, or the dashboard's search form. */
export type EmailFilters = {
  id?: string
  status?: EmailStatus
  to?: string
  tag?: string
  subject?: string
  createdAfter?: string
  createdBefore?: string
}

/** As SQL's `email_page` reads them (migration 48): snake_case, the tag split, times in UTC. */
export function toSqlFilters(filters: EmailFilters): Record<string, string> {
  const out: Record<string, string> = {}
  if (filters.id) out.id = filters.id
  if (filters.status) out.status = filters.status
  if (filters.to) out.to = filters.to.toLowerCase()
  if (filters.tag) {
    const [name = '', value] = filters.tag.split(':')
    out.tag_name = name
    if (value !== undefined) out.tag_value = value
  }
  if (filters.subject) out.subject = filters.subject
  if (filters.createdAfter) out.created_after = toUtc(filters.createdAfter)
  if (filters.createdBefore) out.created_before = toUtc(filters.createdBefore)
  return out
}

// ── Cursors ─────────────────────────────────────────────────────────────────
// Newest first, by (created_at, id). The cursor is the last row's pair,
// opaque to callers: base64url of PostgreSQL's own timestamp text, kept to
// the microsecond so no email between two pages is skipped.

export type Cursor = { at: string; id: string }

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function encodeCursor({ at, id }: Cursor): string {
  return toBase64(utf8(`${at}|${id}`))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function decodeCursor(cursor: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = fromBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  if (!bytes) return null
  const text = String.fromCharCode(...bytes)
  const [at = '', id = '', ...rest] = text.split('|')
  if (rest.length > 0 || !CURSOR_AT.test(at) || !UUID.test(id)) return null
  return { at, id }
}

// ── Rescheduling: PATCH /emails/{id} ────────────────────────────────────────

export const rescheduleSchema = z.strictObject({
  scheduled_at: timestampSchema.describe(
    `The new moment to send it: ISO 8601 with its zone, at most ${EMAIL_LIMITS.maxScheduleHours} hours ahead. A time already past sends it at once.`,
  ),
})

// ── API keys: /api-keys ─────────────────────────────────────────────────────

export const API_KEY_PERMISSIONS = ['full', 'sending'] as const
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number]

export const apiKeyIdSchema = z.uuid()

export const createApiKeySchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1, 'A name is required')
      .max(60)
      .describe('What the key is for, 1 to 60 characters, so you can tell keys apart.'),
    permission: z
      .enum(API_KEY_PERMISSIONS)
      .describe(
        '`sending`: may only send email. `full`: may also read emails, change scheduled ones, and manage keys.',
      ),
    domain_id: z
      .uuid()
      .optional()
      .describe('A sending key only: limit it to sending from this one domain of your account.'),
  })
  .superRefine((key, ctx) => {
    if (key.domain_id && key.permission !== 'sending') {
      ctx.addIssue({
        code: 'custom',
        path: ['domain_id'],
        message: 'Only a sending key can be limited to one domain',
      })
    }
  })

export type CreateApiKey = z.output<typeof createApiKeySchema>

// ── Answers ─────────────────────────────────────────────────────────────────

const at = z.string().describe('ISO 8601, UTC.')
const atOrNull = z.string().nullable().describe('ISO 8601, UTC; null until it happens.')

/** One email as the API shows it: status and times, never a body (MR3). */
export const emailSchema = z.object({
  object: z.literal('email'),
  id: z.uuid(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  reply_to: z.array(z.string()),
  subject: z.string(),
  tags: z.array(z.object({ name: z.string(), value: z.string() })),
  status: z.enum(EMAIL_STATUSES),
  status_reason: z
    .string()
    .nullable()
    .describe('Why it failed, was suppressed or canceled, as a short code; otherwise null.'),
  created_at: at.describe('When it was queued.'),
  scheduled_at: at.describe('When it may be sent: the moment it was queued, unless scheduled.'),
  sent_at: atOrNull,
  delivered_at: atOrNull,
  bounced_at: atOrNull,
  complained_at: atOrNull,
  failed_at: atOrNull,
  canceled_at: atOrNull,
  last_event: z.enum(SEND_EVENTS).nullable().describe('The latest event Amazon SES reported.'),
  last_event_at: atOrNull,
})

export type ApiEmail = z.infer<typeof emailSchema>

/** What `get_email` and `email_page` answer per email: the same, without `object`. */
export const emailRowSchema = emailSchema.omit({ object: true })
export type EmailRow = z.infer<typeof emailRowSchema>

export const emailListSchema = z.object({
  object: z.literal('list'),
  data: z.array(emailSchema),
  has_more: z.boolean(),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass as `cursor` for the next page; null on the last page.'),
})

export const queuedSchema = z.object({
  id: z.uuid().describe('The email’s id: GET /emails/{id} reads it back.'),
})

export const batchQueuedSchema = z.object({
  data: z.array(queuedSchema).describe('One id per email, in the order they were sent.'),
})

/** PATCH /emails/{id} and POST /emails/{id}/cancel. */
export const emailChangedSchema = z.object({
  object: z.literal('email'),
  id: z.uuid(),
  status: z.enum(EMAIL_STATUSES),
  scheduled_at: at,
})

export const apiKeySchema = z.object({
  object: z.literal('api_key'),
  id: z.uuid(),
  name: z.string(),
  prefix: z.string().describe('The key’s first characters, to tell it apart. Never the key.'),
  permission: z.enum(API_KEY_PERMISSIONS),
  domain_id: z.uuid().nullable().describe('The one domain a sending key is limited to, or null.'),
  created_at: at,
  last_used_at: z
    .string()
    .nullable()
    .describe('ISO 8601, UTC: moved at most once a minute; null if never used.'),
})

export const apiKeyListSchema = z.object({
  object: z.literal('list'),
  data: z.array(apiKeySchema).describe('The account’s keys that are not revoked, newest first.'),
})

export const createdApiKeySchema = apiKeySchema.extend({
  key: z
    .string()
    .describe(
      'The key itself. Shown in this answer only: we keep a hash, and cannot show it again.',
    ),
})

export const revokedApiKeySchema = z.object({
  object: z.literal('api_key'),
  id: z.uuid(),
  revoked: z.literal(true),
})

// ── Domains: /domains (the domains package's routes, migration 47) ─────────
// Its handlers build these answers; apps/mail holds them to these schemas in
// a test, so the description cannot drift from what the routes answer.

export const DOMAIN_STATUSES = ['pending', 'verified', 'failed', 'removing'] as const

export const createDomainSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(260)
    .describe('The domain you send from, such as acme.ng. Not mydomainshub.com or its subdomains.'),
})

const domainRecordSchema = z.object({
  record: z
    .enum(['dkim', 'mail_from_mx', 'mail_from_spf', 'dmarc'])
    .describe('What it is for: three DKIM records, the MAIL FROM MX and SPF, and DMARC.'),
  type: z.enum(['CNAME', 'MX', 'TXT']),
  name: z.string().describe('The full host name.'),
  value: z.string().describe('What to put in the record’s value (an MX without its priority).'),
  priority: z.number().int().optional().describe('An MX record’s priority.'),
  required: z.boolean().describe('False only for DMARC, which is suggested, not needed.'),
})

export const domainSchema = z.object({
  object: z.literal('domain'),
  id: z.uuid(),
  name: z.string(),
  status: z.enum(DOMAIN_STATUSES),
  setting_up: z.boolean().describe('True while it is still being set up with Amazon SES.'),
  created_at: at,
  verify_by: atOrNull.describe(
    'A pending domain only: 72 hours after it was added, the time to verify it by. Null otherwise.',
  ),
  verified_at: atOrNull,
  last_checked_at: atOrNull,
  failure: z
    .object({ reason: z.string(), missing_record: z.string().nullable() })
    .nullable()
    .describe('Why it failed, and the record that was missing; null unless failed.'),
  records: z
    .array(domainRecordSchema)
    .describe(
      'The DNS records to add at your DNS host; empty while it is being set up, and once it has failed.',
    ),
})

export const domainListSchema = z.object({
  object: z.literal('list'),
  data: z.array(domainSchema),
})

export const deletedDomainSchema = z.object({
  object: z.literal('domain'),
  id: z.uuid(),
  deleted: z.literal(true),
})
