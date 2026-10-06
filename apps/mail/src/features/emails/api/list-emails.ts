import {
  apiError,
  decodeCursor,
  describeIssues,
  EMAIL_LIMITS,
  encodeCursor,
  listEmailsQuerySchema,
  readQuery,
  refusalToApiError,
  toSqlFilters,
} from '@dr/shared/mail'
import type { ApiDeps } from '@/features/api/deps'
import { authenticateFull } from '@/features/api/lib/authenticate'
import { apiErrorResponse, apiJson } from '@/features/api/lib/respond'

/**
 * GET /api/v1/emails (MAIL-SPEC §6): the account's log, newest first, a page
 * at a time, through `list_emails` (migration 48) — the same function the
 * dashboard's log reads through. Every filter given must match; a filter we
 * do not know is refused, never ignored (N9b). A full-access key only.
 */

export const BAD_CURSOR = apiError(
  'validation_error',
  'cursor is not one this API gave. Pass next_cursor from the page before, as it was given.',
)

export async function listEmails(
  request: Request,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)

  const read = readQuery(new URL(request.url).searchParams)
  if (!read.ok) {
    return apiErrorResponse(
      apiError('validation_error', `${read.repeated}: give each query parameter once`),
      requestId,
    )
  }
  const parsed = listEmailsQuerySchema.safeParse(read.query)
  if (!parsed.success) {
    return apiErrorResponse(apiError('validation_error', describeIssues(parsed.error)), requestId)
  }
  const query = parsed.data
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor)
  if (query.cursor !== undefined && !cursor) return apiErrorResponse(BAD_CURSOR, requestId)

  const answer = await deps.store.listEmails({
    accountId: auth.key.accountId,
    filters: toSqlFilters({
      ...(query.status ? { status: query.status } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.subject ? { subject: query.subject } : {}),
      ...(query.created_after ? { createdAfter: query.created_after } : {}),
      ...(query.created_before ? { createdBefore: query.created_before } : {}),
    }),
    cursor,
    limit: query.limit ?? EMAIL_LIMITS.defaultPage,
  })
  if (!answer.ok) return apiErrorResponse(refusalToApiError(answer), requestId)
  return apiJson(
    {
      object: 'list',
      data: answer.data.map((email) => ({ object: 'email', ...email })),
      has_more: answer.hasMore,
      next_cursor: answer.next ? encodeCursor(answer.next) : null,
    },
    200,
    requestId,
  )
}
