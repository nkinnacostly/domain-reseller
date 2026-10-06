import {
  apiError,
  describeIssues,
  EMAIL_LIMITS,
  idempotencyKeySchema,
  refusalToApiError,
  requestHash,
  sendEmailSchema,
  toEnqueueInput,
} from '@dr/shared/mail'
import type { ApiDeps } from '@/features/api/deps'
import { authenticate } from '@/features/api/lib/authenticate'
import { apiErrorResponse, apiJson } from '@/features/api/lib/respond'
import { logger } from '@/lib/logger'

/**
 * POST /api/v1/emails (MAIL-SPEC §6): queue one email and answer its id.
 * Thin by design — validate, one SQL function, answer:
 *
 *   key  → authenticate_key (hash, revoked, rate limit, last used)
 *   body → sendEmailSchema (Zod; unknown fields refused)
 *   SQL  → enqueue_email: Idempotency-Key (24 h), then reserve_send — the
 *          gate (MR2) and the caps, reserved atomically — then the row.
 *
 * The worker sends it within seconds (§3.1). Nothing about the email — not
 * an address, the subject or the body — reaches a log line (N13, MR4).
 */

const TOO_LARGE = {
  ...apiError(
    'validation_error',
    'The request is larger than 4 MB. Send fewer or smaller attachments.',
  ),
  status: 413,
}
const NOT_JSON = apiError(
  'validation_error',
  'The body must be a JSON object, sent with Content-Type: application/json.',
)
const BAD_IDEMPOTENCY_KEY = apiError(
  'validation_error',
  'The Idempotency-Key header must be 1 to 256 printable ASCII characters, without spaces.',
)

/** The body as text, refused past the limit without reading it all. */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > EMAIL_LIMITS.maxRequestBytes) return null
  const text = await request.text()
  return new TextEncoder().encode(text).length > EMAIL_LIMITS.maxRequestBytes ? null : text
}

export async function sendEmail(
  request: Request,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticate(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  const { key } = auth

  const rawKey = request.headers.get('idempotency-key')
  const idempotency = rawKey === null ? null : idempotencyKeySchema.safeParse(rawKey)
  if (idempotency && !idempotency.success) return apiErrorResponse(BAD_IDEMPOTENCY_KEY, requestId)

  const text = await readBody(request)
  if (text === null) return apiErrorResponse(TOO_LARGE, requestId)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return apiErrorResponse(NOT_JSON, requestId)
  }
  const parsed = sendEmailSchema.safeParse(json)
  if (!parsed.success) {
    return apiErrorResponse(apiError('validation_error', describeIssues(parsed.error)), requestId)
  }

  const email = toEnqueueInput(parsed.data)
  const idempotencyKey = idempotency?.success ? idempotency.data : null
  const answer = await deps.store.enqueueEmail({
    accountId: key.accountId,
    keyId: key.keyId,
    email,
    idempotencyKey,
    requestHash: idempotencyKey ? await requestHash(email) : null,
  })
  if (!answer.ok) {
    logger.info(
      {
        requestId,
        keyId: key.keyId,
        accountId: key.accountId,
        refused: answer.code,
        scope: answer.scope,
      },
      'v1 send refused',
    )
    return apiErrorResponse(refusalToApiError(answer), requestId)
  }
  logger.info(
    {
      requestId,
      keyId: key.keyId,
      accountId: key.accountId,
      emailId: answer.id,
      status: answer.status,
      replayed: answer.replayed,
      recipients: email.email.to.length + email.email.cc.length + email.email.bcc.length,
    },
    'v1 send queued',
  )
  return apiJson({ id: answer.id }, 200, requestId)
}
