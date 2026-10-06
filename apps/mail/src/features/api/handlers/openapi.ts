import { buildOpenApi, type OpenApiDocument } from '@dr/shared/mail'
import { env } from '@/lib/env'
import { apiJson } from '../lib/respond'

/**
 * GET /api/v1/openapi.json (MAIL-SPEC §6): OpenAPI 3.1, generated from the
 * Zod schemas the handlers validate with (`@dr/shared/mail`'s openapi.ts),
 * so it cannot drift from what the API accepts. Public, like the docs; it
 * carries x-request-id like every other answer.
 */

let built: OpenApiDocument | null = null

export function openApiDocument(): OpenApiDocument {
  built ??= buildOpenApi({ serverUrl: `${env.NEXT_PUBLIC_MAIL_URL}/api/v1` })
  return built
}

export function openApi(requestId: string): Response {
  return apiJson(openApiDocument(), 200, requestId)
}
