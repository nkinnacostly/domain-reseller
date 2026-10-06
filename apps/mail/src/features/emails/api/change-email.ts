import {
  apiError,
  describeIssues,
  emailIdSchema,
  refusalToApiError,
  rescheduleSchema,
  toUtc,
} from '@dr/shared/mail'
import type { ApiDeps } from '@/features/api/deps'
import { authenticateFull } from '@/features/api/lib/authenticate'
import { readJson } from '@/features/api/lib/body'
import { apiErrorResponse, apiJson } from '@/features/api/lib/respond'
import type { ChangeAnswer } from '@/features/api/store'
import { logger } from '@/lib/logger'
import { NOT_FOUND } from './get-email'

/**
 * Changing an email still waiting in the queue (MAIL-SPEC §3.1, §6):
 *
 *   PATCH /api/v1/emails/{id}        — move it to another moment
 *   POST  /api/v1/emails/{id}/cancel — cancel it, its recipients given back
 *
 * Only while it waits: once a worker has tried it, it may have reached SES,
 * so SQL answers `not_pending` and we answer 409. A full-access key only.
 */

function answered(answer: ChangeAnswer, requestId: string, what: string): Response {
  if (!answer.ok) {
    logger.info({ requestId, refused: answer.code, status: answer.status }, `v1 ${what} refused`)
    const error = refusalToApiError(answer)
    return apiErrorResponse(answer.code === 'not_found' ? NOT_FOUND : error, requestId)
  }
  logger.info({ requestId, emailId: answer.id, status: answer.status }, `v1 ${what} done`)
  return apiJson(
    { object: 'email', id: answer.id, status: answer.status, scheduled_at: answer.scheduledAt },
    200,
    requestId,
  )
}

export async function rescheduleEmail(
  request: Request,
  id: string,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  const emailId = emailIdSchema.safeParse(id)
  if (!emailId.success) return apiErrorResponse(NOT_FOUND, requestId)

  const body = await readJson(request)
  if (!body.ok) return apiErrorResponse(body.error, requestId)
  const parsed = rescheduleSchema.safeParse(body.value)
  if (!parsed.success) {
    return apiErrorResponse(apiError('validation_error', describeIssues(parsed.error)), requestId)
  }
  const answer = await deps.store.rescheduleEmail(
    auth.key.accountId,
    emailId.data,
    toUtc(parsed.data.scheduled_at),
  )
  return answered(answer, requestId, 'reschedule')
}

export async function cancelEmail(
  request: Request,
  id: string,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  const emailId = emailIdSchema.safeParse(id)
  if (!emailId.success) return apiErrorResponse(NOT_FOUND, requestId)
  const answer = await deps.store.cancelEmail(auth.key.accountId, emailId.data)
  return answered(answer, requestId, 'cancel')
}
