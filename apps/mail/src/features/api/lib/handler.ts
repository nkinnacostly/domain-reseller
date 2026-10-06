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

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
type Method = (typeof METHODS)[number]
type Handler = (request: Request) => Promise<Response>

/**
 * The methods a path does not take, answered in the API's shape — JSON with
 * `x-request-id` and an `allow` header — rather than Next's empty 405.
 *
 * ```ts
 * export const { PATCH, PUT, DELETE } = otherMethods(['GET', 'POST'])
 * ```
 */
export function otherMethods(allowed: readonly Method[]): Record<Method, Handler> {
  const words = allowed.join(' and ')
  const handler: Handler = async () => {
    const requestId = newRequestId()
    const response = apiErrorResponse(
      {
        ...apiError(
          'not_found',
          `This path takes ${words} only. The reference lists every path: /docs/api.`,
        ),
        status: 405,
      },
      requestId,
    )
    response.headers.set('allow', allowed.join(', '))
    return response
  }
  return Object.fromEntries(METHODS.map((method) => [method, handler])) as Record<Method, Handler>
}

/** Any path under /api/v1 that does not exist: a JSON 404, as every other answer. */
export async function noSuchPath(): Promise<Response> {
  return apiErrorResponse(
    apiError(
      'not_found',
      'There is no such path in the v1 API. The reference lists every path: /docs/api.',
    ),
    newRequestId(),
  )
}
