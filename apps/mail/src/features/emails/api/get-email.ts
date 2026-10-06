import { apiError, emailIdSchema } from '@dr/shared/mail'
import type { ApiDeps } from '@/features/api/deps'
import { authenticateFull, FULL_KEY_ONLY } from '@/features/api/lib/authenticate'
import { apiErrorResponse, apiJson } from '@/features/api/lib/respond'

/**
 * GET /api/v1/emails/{id} (MAIL-SPEC §6): status, timestamps and the last
 * event — never the body (MR3). Only the account's own emails: `get_email`
 * matches the id and the key's account together, so another account's id
 * is simply not found. A sending key may only send (§9, MR7), so reading
 * takes a full-access key.
 */

export const NOT_FOUND = apiError('not_found', 'No email with that id belongs to this account.')
export const SENDING_KEY = FULL_KEY_ONLY

export async function getEmail(
  request: Request,
  id: string,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)

  const emailId = emailIdSchema.safeParse(id)
  if (!emailId.success) return apiErrorResponse(NOT_FOUND, requestId)
  const email = await deps.store.getEmail(auth.key.accountId, emailId.data)
  if (!email) return apiErrorResponse(NOT_FOUND, requestId)
  return apiJson({ object: 'email', ...email }, 200, requestId)
}
