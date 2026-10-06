import {
  apiError,
  batchSchema,
  describeIssues,
  refusalToApiError,
  requestHash,
  toEnqueueInput,
} from '@dr/shared/mail'
import type { ApiDeps } from '@/features/api/deps'
import { authenticate } from '@/features/api/lib/authenticate'
import { readIdempotencyKey, readJson } from '@/features/api/lib/body'
import { apiErrorResponse, apiJson } from '@/features/api/lib/respond'
import { logger } from '@/lib/logger'

/**
 * POST /api/v1/emails/batch (MAIL-SPEC §6): up to 100 emails, each
 * validated as POST /emails validates one; then `enqueue_batch` queues them
 * all or none (migration 48). A refusal names the first email refused,
 * `emails[n]`, in the words a single send would get. One Idempotency-Key
 * covers the whole batch, fingerprinted in its order.
 */

export const NOT_A_BATCH = apiError(
  'validation_error',
  'The body must be a JSON array of 1 to 100 emails, each shaped as for POST /emails.',
)

export async function sendBatch(
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
  if (!Array.isArray(body.value)) return apiErrorResponse(NOT_A_BATCH, requestId)
  const parsed = batchSchema.safeParse(body.value)
  if (!parsed.success) {
    return apiErrorResponse(
      apiError('validation_error', describeIssues(parsed.error, 'emails')),
      requestId,
    )
  }

  const emails = parsed.data.map(toEnqueueInput)
  // TODO(MB6 merge): MAIL-SPEC §7.6's content check — one line here, calling
  // `features/safety`'s check on each of `emails` and answering the first
  // refusal as `emails[n]: …` before enqueue_batch. That module is not on
  // master yet (6 Oct 2026).
  const idempotencyKey = idempotency.value
  const answer = await deps.store.enqueueBatch({
    accountId: key.accountId,
    keyId: key.keyId,
    emails,
    idempotencyKey,
    requestHash: idempotencyKey ? await requestHash(emails) : null,
  })
  if (!answer.ok) {
    logger.info(
      {
        requestId,
        keyId: key.keyId,
        accountId: key.accountId,
        refused: answer.code,
        field: answer.field,
        index: answer.index,
        size: emails.length,
      },
      'v1 batch refused',
    )
    const error = refusalToApiError(answer)
    return apiErrorResponse(
      answer.index === undefined
        ? error
        : { ...error, message: `emails[${answer.index}]: ${error.message}` },
      requestId,
    )
  }
  logger.info(
    {
      requestId,
      keyId: key.keyId,
      accountId: key.accountId,
      emails: answer.ids.length,
      replayed: answer.replayed,
      recipients: emails.reduce(
        (sum, { email }) => sum + email.to.length + email.cc.length + email.bcc.length,
        0,
      ),
    },
    'v1 batch queued',
  )
  return apiJson({ data: answer.ids.map((id) => ({ id })) }, 200, requestId)
}
