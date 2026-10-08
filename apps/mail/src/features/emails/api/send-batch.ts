import {
  apiError,
  batchSchema,
  contentProblem,
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

/**
 * Resend's SDK sends `x-batch-validation: strict` with every batch, which is
 * what this API does. `permissive` — queue the good ones, report the rest —
 * is not, and a batch is refused rather than half-sent the caller did not ask for.
 */
export const NOT_STRICT = apiError(
  'validation_error',
  'x-batch-validation: permissive is not supported. A batch is checked whole: if one email is refused, none is queued. Leave the header out, or send strict.',
)

const strictOrAbsent = (request: Request) => {
  const mode = request.headers.get('x-batch-validation')
  return mode === null || mode.trim().toLowerCase() === 'strict'
}

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
  if (!strictOrAbsent(request)) return apiErrorResponse(NOT_STRICT, requestId)

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
  // §7.6: the first email the content check refuses refuses the batch, by its place.
  const content = contentProblem(emails)
  if (content) {
    logger.info(
      { requestId, keyId: key.keyId, refused: content.rule, index: content.index },
      'v1 batch refused by content',
    )
    return apiErrorResponse(
      { ...content.error, message: `emails[${content.index}]: ${content.error.message}` },
      requestId,
    )
  }
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
