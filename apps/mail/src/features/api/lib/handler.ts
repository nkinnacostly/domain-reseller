import { apiError } from '@dr/shared/mail'
import { logger } from '@/lib/logger'
import { StoreError } from '../store'
import { apiErrorResponse, newRequestId } from './respond'

/**
 * Every v1 handler runs inside this: a request id from the first line, and
 * anything unexpected — the database down, a setting missing — answered as
 * `internal_error` with that id. Logged by route, error name and code (N13):
 * our own errors' messages name settings, never values.
 */

export const INTERNAL = apiError(
  'internal_error',
  'Something went wrong on our side. Try again in a moment, and quote the x-request-id if it keeps happening.',
)

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof StoreError) return { err: error.message, code: error.code }
  if (error instanceof Error) return { err: error.name, message: error.message.slice(0, 200) }
  return { err: 'unknown' }
}

export async function runApi<Deps>(
  route: string,
  makeDeps: () => Deps,
  handle: (deps: Deps, requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = newRequestId()
  try {
    return await handle(makeDeps(), requestId)
  } catch (error) {
    logger.error({ route, requestId, ...describe(error) }, 'v1 request failed')
    return apiErrorResponse(INTERNAL, requestId)
  }
}
