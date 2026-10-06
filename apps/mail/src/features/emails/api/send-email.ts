import {
  apiError,
  describeIssues,
  refusalToApiError,
  requestHash,
  sendEmailSchema,
  toEnqueueInput,
} from '@dr/shared/mail'
import type { ApiDeps } from '@/features/api/deps'
import { authenticate } from '@/features/api/lib/authenticate'
import { readIdempotencyKey, readJson } from '@/features/api/lib/body'
import { apiErrorResponse, apiJson } from '@/features/api/lib/respond'
import { logger } from '@/lib/logger'

/**
 * POST /api/v1/emails (MAIL-SPEC §6): queue one email and answer its id.
 * Thin by design — validate, one SQL function, answer:
 *
 *   key  → authenticate_key (hash, revoked, rate limit, last used)
 *   body → sendEmailSchema (Zod; unknown fields refused)
 *   SQL  → enqueue_email: Idempotency-Key (24 h), then reserve_send — the
 *          gate (MR2) and the caps, reserved atomically — then the row,
 *          due now or at `scheduled_at` (§3.1, migration 48).
 *
 * The worker sends it when it is due. Nothing about the email — not an
 * address, the subject or the body — reaches a log line (N13, MR4).
 */
export async function sendEmail(
  request: Request,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticate(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  const { key } = auth

  const idempotency = readIdempotencyKey(request)
  if (!idempotency.ok) return apiErrorResponse(idempotency.error, requestId)

  const body = await readJson(request)
  if (!body.ok) return apiErrorResponse(body.error, requestId)
  const parsed = sendEmailSchema.safeParse(body.value)
  if (!parsed.success) {
    return apiErrorResponse(apiError('validation_error', describeIssues(parsed.error)), requestId)
  }

  const email = toEnqueueInput(parsed.data)
  const idempotencyKey = idempotency.value
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
        field: answer.field,
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
      scheduled: Boolean(email.email.scheduled_at),
      recipients: email.email.to.length + email.email.cc.length + email.email.bcc.length,
    },
    'v1 send queued',
  )
  return apiJson({ id: answer.id }, 200, requestId)
}
