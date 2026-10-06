import { apiDeps } from '@/features/api/deps'
import { createApiKey, listApiKeys } from '@/features/api/handlers/api-keys'
import { otherMethods, runApi } from '@/features/api/lib/handler'

/** GET /api/v1/api-keys — the account's live keys (MAIL-SPEC §6, MR7). */
export function GET(request: Request) {
  return runApi('GET /v1/api-keys', apiDeps, (deps, requestId) =>
    listApiKeys(request, deps, requestId),
  )
}

/** POST /api/v1/api-keys — a new key, answered once. */
export function POST(request: Request) {
  return runApi('POST /v1/api-keys', apiDeps, (deps, requestId) =>
    createApiKey(request, deps, requestId),
  )
}

export const { PATCH, PUT, DELETE } = otherMethods(['GET', 'POST'])
