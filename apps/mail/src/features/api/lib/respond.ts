import type { ApiError } from '@dr/shared/mail'

/**
 * Answers of the v1 API (MAIL-SPEC §6): JSON in and out, every response
 * carrying `x-request-id` — the id our logs carry, so a developer's support
 * email can be matched to them — and never cached.
 */

export const REQUEST_ID_HEADER = 'x-request-id'

export const newRequestId = (): string => crypto.randomUUID()

export function apiJson(
  body: unknown,
  status: number,
  requestId: string,
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { [REQUEST_ID_HEADER]: requestId, 'cache-control': 'no-store', ...extra },
  })
}

/** `{ name, message }` with its status; a 429 says when to come back (`retry-after`, seconds). */
export function apiErrorResponse(error: ApiError, requestId: string): Response {
  return apiJson(
    { name: error.name, message: error.message },
    error.status,
    requestId,
    error.retryAfter !== undefined ? { 'retry-after': String(error.retryAfter) } : {},
  )
}
