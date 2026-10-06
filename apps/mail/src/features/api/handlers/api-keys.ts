import {
  apiError,
  apiKeyIdSchema,
  createApiKeySchema,
  describeIssues,
  hashApiKey,
  newApiKey,
  refusalToApiError,
} from '@dr/shared/mail'
import { logger } from '@/lib/logger'
import type { ApiDeps } from '../deps'
import { authenticateFull } from '../lib/authenticate'
import { readJson } from '../lib/body'
import { apiErrorResponse, apiJson } from '../lib/respond'
import type { KeyRow } from '../store'

/**
 * /api/v1/api-keys (MAIL-SPEC §6, MR7): list, create and revoke the
 * account's keys — with a full-access key only, which SQL asks again
 * (api_list_keys, api_create_key, api_revoke_key; migration 48). A new key
 * is made here, answered once, and only its prefix and its hash
 * (sha256(pepper ‖ key)) reach the database; neither key ever reaches a log.
 */

export const KEY_NOT_FOUND = apiError(
  'not_found',
  'No API key with that id belongs to this account.',
)

const view = (key: KeyRow) => ({
  object: 'api_key' as const,
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  permission: key.permission,
  domain_id: key.domainId,
  created_at: key.createdAt,
  last_used_at: key.lastUsedAt,
})

export async function listApiKeys(
  request: Request,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  const keys = await deps.store.listKeys(auth.key.accountId)
  return apiJson({ object: 'list', data: keys.map(view) }, 200, requestId)
}

export async function createApiKey(
  request: Request,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)

  const body = await readJson(request)
  if (!body.ok) return apiErrorResponse(body.error, requestId)
  const parsed = createApiKeySchema.safeParse(body.value)
  if (!parsed.success) {
    return apiErrorResponse(apiError('validation_error', describeIssues(parsed.error)), requestId)
  }

  const { key, prefix } = newApiKey()
  const answer = await deps.store.createKey({
    accountId: auth.key.accountId,
    actorKeyId: auth.key.keyId,
    name: parsed.data.name,
    permission: parsed.data.permission,
    prefix,
    keyHash: await hashApiKey(key, deps.pepper),
    domainId: parsed.data.domain_id ?? null,
  })
  if (!answer.ok) {
    logger.info({ requestId, keyId: auth.key.keyId, refused: answer.code }, 'v1 key refused')
    return apiErrorResponse(refusalToApiError(answer), requestId)
  }
  logger.info(
    { requestId, keyId: auth.key.keyId, accountId: auth.key.accountId, created: answer.key.id },
    'v1 key created',
  )
  return apiJson({ ...view(answer.key), key }, 200, requestId)
}

export async function revokeApiKey(
  request: Request,
  id: string,
  deps: ApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  const keyId = apiKeyIdSchema.safeParse(id)
  if (!keyId.success) return apiErrorResponse(KEY_NOT_FOUND, requestId)

  const answer = await deps.store.revokeKey(auth.key.accountId, auth.key.keyId, keyId.data)
  if (!answer.ok) {
    logger.info({ requestId, keyId: auth.key.keyId, refused: answer.code }, 'v1 key revoke refused')
    return apiErrorResponse(
      answer.code === 'not_found' ? KEY_NOT_FOUND : refusalToApiError(answer),
      requestId,
    )
  }
  logger.info(
    { requestId, keyId: auth.key.keyId, accountId: auth.key.accountId, revoked: answer.keyId },
    'v1 key revoked',
  )
  return apiJson({ object: 'api_key', id: answer.keyId, revoked: true }, 200, requestId)
}
