import { z } from 'zod'

/**
 * The v1 API's error answer (MAIL-SPEC §6): `{ name, message }` with the
 * matching status, every response carrying `x-request-id`. The words say
 * what happened, why, and what to do next; they never quote an address, a
 * subject, a body or a key (N13, MR4).
 */

export const API_ERROR_NAMES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'quota_exceeded',
  'domain_not_verified',
  'account_paused',
  'internal_error',
] as const

export type ApiErrorName = (typeof API_ERROR_NAMES)[number]

export const API_ERROR_STATUS: Record<ApiErrorName, number> = {
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  quota_exceeded: 429,
  domain_not_verified: 403,
  account_paused: 403,
  internal_error: 500,
}

export const apiErrorSchema = z.strictObject({
  name: z.enum(API_ERROR_NAMES),
  message: z.string().min(1),
  statusCode: z
    .number()
    .int()
    .describe(
      'The HTTP status again, in the body, where SDKs built for other email APIs look for it.',
    ),
})

export type ApiError = {
  name: ApiErrorName
  message: string
  status: number
  /** Seconds, for the `retry-after` header of a 429. */
  retryAfter?: number
}

export const apiError = (name: ApiErrorName, message: string, retryAfter?: number): ApiError => ({
  name,
  message,
  status: API_ERROR_STATUS[name],
  ...(retryAfter !== undefined ? { retryAfter: Math.max(1, Math.ceil(retryAfter)) } : {}),
})

/** What the SQL functions answer when they refuse (enqueue_email, reserve_send, authenticate_key). */
export const sqlRefusalSchema = z.looseObject({
  ok: z.literal(false),
  code: z.string(),
  field: z.string().optional(),
  reason: z.string().optional(),
  scope: z.enum(['day', 'month']).optional(),
  cap: z.number().optional(),
  /** `key_limit` (migration 54): the most live keys an account may hold. */
  max: z.number().optional(),
  retryAfter: z.number().optional(),
  retryAfterMs: z.number().optional(),
  /** `not_pending`: the email's status now (cancel_email, reschedule_email). */
  status: z.string().optional(),
  /** `enqueue_batch`: which email of the batch was refused, from 0. */
  index: z.number().int().min(0).optional(),
})

export type SqlRefusal = z.infer<typeof sqlRefusalSchema>

const FIELD_WORDS: Record<string, string> = {
  body: 'The email needs html or text.',
  from: 'The from address is not an email address, or "Name <address>".',
  recipients: 'The recipients are not valid: at most 50 across to, cc and bcc, each once.',
  subject: 'The subject must be one line of 1 to 998 characters.',
  size: 'The email is too large for one request.',
  idempotency_key: 'The Idempotency-Key header must be printable ASCII, at most 256 characters.',
  scheduled_at:
    'scheduled_at must be an ISO 8601 date and time with its zone, at most 72 hours from now.',
  emails: 'A batch is a JSON array of 1 to 100 emails.',
  name: 'The name must be 1 to 60 characters.',
  permission: 'The permission must be "full" or "sending".',
  domain:
    'domain_id must be one of this account’s domains, and only a sending key can be limited to one.',
  key: 'The key could not be made. Try again.',
}

/** A refusal from SQL in the API's words. */
export function refusalToApiError(refusal: SqlRefusal): ApiError {
  switch (refusal.code) {
    case 'unauthorized':
      return apiError(
        'unauthorized',
        'The API key is missing, wrong or revoked. Send it as "Authorization: Bearer mdh_live_…".',
      )
    case 'rate_limited':
      return apiError(
        'rate_limited',
        'Too many requests with this API key. Wait for the time in the retry-after header, then try again.',
        (refusal.retryAfterMs ?? 1000) / 1000,
      )
    case 'forbidden':
      return apiError(
        'forbidden',
        refusal.reason === 'key_domain'
          ? 'This API key may send only from the domain it was made for. Use that domain, or a key without that limit.'
          : 'This API key may not do that.',
      )
    case 'sandbox_recipient':
      return apiError(
        'forbidden',
        'This account is in the sandbox, so it can send only to its own members’ confirmed addresses. Sending to anyone opens once an admin approves the account.',
      )
    case 'account_not_ready':
      return apiError(
        'forbidden',
        'This account is still being set up for sending. Try again in a few minutes.',
      )
    case 'domain_not_verified':
      return apiError(
        'domain_not_verified',
        'The from address’s domain is not verified on this account. Add it under Domains and finish its DNS records first.',
      )
    case 'account_paused':
      return apiError(
        'account_paused',
        'Sending is paused on this account. The dashboard says why; email us if you think it is a mistake.',
      )
    case 'quota_exceeded': {
      const cap =
        refusal.cap === undefined ? '' : `${new Intl.NumberFormat('en-NG').format(refusal.cap)} `
      return apiError(
        'quota_exceeded',
        refusal.scope === 'month'
          ? `This account has reached its plan’s ${cap}emails for this month (Lagos time). Sending opens again on the 1st, or sooner on a larger plan.`
          : `This account has reached its ${cap}emails for today (Lagos time). Sending opens again at midnight.`,
        refusal.retryAfter,
      )
    }
    case 'budget_exceeded':
      return apiError(
        'quota_exceeded',
        'We have reached our own sending limit for the moment — this is our limit, not your plan’s. Try again after the time in the retry-after header.',
        refusal.retryAfter ?? 3600,
      )
    case 'idempotency_conflict':
      return {
        ...apiError(
          'validation_error',
          'This Idempotency-Key was used for a different request in the last 24 hours. Use a new key for a new email.',
        ),
        status: 409,
      }
    case 'validation':
      return apiError(
        'validation_error',
        (refusal.field && FIELD_WORDS[refusal.field]) ?? 'The request is not valid.',
      )
    case 'not_found':
      return apiError('not_found', 'Nothing with that id belongs to this account.')
    case 'not_pending':
      // A state conflict, answered as the idempotency conflict is: 409.
      return {
        ...apiError(
          'validation_error',
          `This email can no longer be changed: its status is ${refusal.status ?? 'past queued'}. Only an email still waiting in the queue can be rescheduled or canceled.`,
        ),
        status: 409,
      }
    case 'account_closed':
      return apiError('forbidden', 'This account is closed, so nothing on it can be changed.')
    case 'key_limit':
      return apiError(
        'forbidden',
        `This account has ${refusal.max === undefined ? 'the most' : `${refusal.max}`} live API keys, the most it may hold. Revoke one it no longer uses, then make the new one.`,
      )
    case 'suppressed':
      // Rescheduling (migration 54) asks the gate again; a recipient suppressed since is refused.
      return {
        ...apiError(
          'validation_error',
          'A recipient of this email is on this account’s suppression list now, so it cannot be moved. Cancel it, or remove the address from the list in the dashboard first.',
        ),
        status: 409,
      }
    default:
      return apiError('internal_error', 'Something went wrong on our side. Try again in a moment.')
  }
}

/** `[3].to`-style paths: indexes in brackets, names after dots, under an optional root. */
function issuePath(path: readonly PropertyKey[], root: string): string {
  const text = path
    .map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`))
    .join('')
  const joined = `${root}${text}`.replace(/^\./, '')
  return joined || 'body'
}

/**
 * Fields other email APIs take that we do not (N9b: refused, never ignored),
 * each with what to do instead — someone moving code across should not have
 * to guess from "Unrecognized key".
 */
export const UNSUPPORTED_FIELDS: Readonly<Record<string, string>> = {
  path: 'attachments by URL are not supported; send the file itself in content, as base64',
  template: 'stored templates are not supported; send the email’s html or text',
  topic_id: 'topics are not supported; leave it out',
  after: 'pages go by cursor: pass the next_cursor of the page before as cursor',
  before: 'pages go newest first by cursor; start again without one for the newest',
}

function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code !== 'unrecognized_keys') return issue.message
  const known = issue.keys.filter((key) => Object.hasOwn(UNSUPPORTED_FIELDS, key))
  if (known.length === 0) return issue.message
  return known.map((key) => `${key}: ${UNSUPPORTED_FIELDS[key]}`).join('; ')
}

/**
 * Zod's issues in a sentence: the field paths and what is wrong — never the
 * values. `root` names what the body is (`emails` for a batch, so a path
 * reads `emails[3].to`).
 */
export function describeIssues(error: z.ZodError, root = ''): string {
  const parts = error.issues
    .slice(0, 5)
    .map((issue) => `${issuePath(issue.path, root)}: ${issueMessage(issue)}`)
  return parts.join('; ')
}
