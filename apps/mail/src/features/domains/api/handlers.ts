import 'server-only'

import { apiError } from '@dr/shared/mail'
import { z } from 'zod'
import type { ApiDeps } from '@/features/api/deps'
import { authenticate } from '@/features/api/lib/authenticate'
import { apiErrorResponse, apiJson } from '@/features/api/lib/respond'
import { logger } from '@/lib/logger'
import { normaliseDomain } from '../lib/names'
import { domainRecords } from '../lib/records'
import { domainApiError, domainMessage } from '../lib/results'
import type { DomainApiStore, DomainView } from '../queries/api-store'
import { settleDomainNow } from '../queries/settle'
import { createDomainBodySchema } from '../schemas'

/**
 * /api/v1/domains (MAIL-SPEC §5, §6): add, list, read, check and remove the
 * account's domains — with a full-access key only, which SQL asks again
 * (api_*_domain, migration 47) — in the API's own shape: JSON with
 * `x-request-id`, errors as `{ name, message }`. Adding sets the domain up
 * with SES at once and answers its DNS records; `verify` is the dashboard's
 * "Check now". Logs carry ids only (N13).
 */

export type DomainApiDeps = ApiDeps & { domains: DomainApiStore; region: string }

export const FULL_KEY_ONLY = apiError(
  'forbidden',
  'Managing domains takes a full-access API key. Use one, or manage domains in the dashboard.',
)
export const DOMAIN_NOT_FOUND = apiError(
  'not_found',
  'No domain with that id belongs to this account.',
)

async function authenticateFull(request: Request, deps: DomainApiDeps) {
  const auth = await authenticate(request, deps)
  if (!auth.ok) return auth
  if (auth.key.permission !== 'full') return { ok: false as const, error: FULL_KEY_ONLY }
  return auth
}

/** A domain as the API shows it, with the records to add while it is pending. */
export function domainJson(view: DomainView, region: string) {
  return {
    object: 'domain' as const,
    id: view.id,
    name: view.name,
    status: view.status,
    setting_up: view.settingUp,
    created_at: view.createdAt,
    verify_by: view.deadline,
    verified_at: view.verifiedAt,
    last_checked_at: view.lastCheckedAt,
    failure: view.failedReason
      ? { reason: view.failedReason, missing_record: view.missingRecord }
      : null,
    records:
      view.status === 'failed' || view.dkimTokens.length === 0
        ? []
        : domainRecords({
            name: view.name,
            dkimTokens: view.dkimTokens,
            mailFromDomain: view.mailFromDomain,
            region,
          }).map((record) => ({
            record: record.purpose,
            type: record.type,
            name: record.name,
            value: record.value,
            ...(record.priority !== undefined ? { priority: record.priority } : {}),
            required: record.required,
          })),
  }
}

const isId = (value: string) => z.uuid().safeParse(value).success

export async function listDomainsApi(
  request: Request,
  deps: DomainApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  const answer = await deps.domains.list(auth.key.accountId, auth.key.keyId)
  if (!answer.ok) return apiErrorResponse(domainApiError(answer), requestId)
  return apiJson(
    { object: 'list', data: answer.domains.map((view) => domainJson(view, deps.region)) },
    200,
    requestId,
  )
}

export async function createDomainApi(
  request: Request,
  deps: DomainApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiErrorResponse(
      apiError('validation_error', 'The body must be JSON, such as {"name": "acme.ng"}.'),
      requestId,
    )
  }
  const parsed = createDomainBodySchema.safeParse(body)
  const name = parsed.success ? normaliseDomain(parsed.data.name) : null
  if (!name) {
    return apiErrorResponse(
      apiError('validation_error', domainMessage({ code: 'validation' })),
      requestId,
    )
  }
  const added = await deps.domains.add(auth.key.accountId, auth.key.keyId, name)
  if (!added.ok) {
    logger.info({ requestId, keyId: auth.key.keyId, refused: added.code }, 'v1 domain refused')
    return apiErrorResponse(domainApiError(added), requestId)
  }
  await settleDomainNow({
    accountId: auth.key.accountId,
    domainId: added.domainId,
    provision: true,
  })
  const read = await deps.domains.get(auth.key.accountId, auth.key.keyId, added.domainId)
  if (!read.ok) return apiErrorResponse(domainApiError(read), requestId)
  logger.info({ requestId, keyId: auth.key.keyId, domainId: added.domainId }, 'v1 domain added')
  return apiJson(domainJson(read.domain, deps.region), 200, requestId)
}

export async function getDomainApi(
  request: Request,
  id: string,
  deps: DomainApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  if (!isId(id)) return apiErrorResponse(DOMAIN_NOT_FOUND, requestId)
  const read = await deps.domains.get(auth.key.accountId, auth.key.keyId, id)
  if (!read.ok) return apiErrorResponse(domainApiError(read), requestId)
  return apiJson(domainJson(read.domain, deps.region), 200, requestId)
}

/** POST /domains/{id}/verify — the dashboard's "Check now": SES is read, and the domain answered. */
export async function verifyDomainApi(
  request: Request,
  id: string,
  deps: DomainApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  if (!isId(id)) return apiErrorResponse(DOMAIN_NOT_FOUND, requestId)
  const before = await deps.domains.get(auth.key.accountId, auth.key.keyId, id)
  if (!before.ok) return apiErrorResponse(domainApiError(before), requestId)
  if (before.domain.status === 'pending' || before.domain.status === 'verified') {
    await settleDomainNow({ accountId: auth.key.accountId, domainId: id, provision: true })
  }
  const after = await deps.domains.get(auth.key.accountId, auth.key.keyId, id)
  if (!after.ok) return apiErrorResponse(domainApiError(after), requestId)
  return apiJson(domainJson(after.domain, deps.region), 200, requestId)
}

export async function deleteDomainApi(
  request: Request,
  id: string,
  deps: DomainApiDeps,
  requestId: string,
): Promise<Response> {
  const auth = await authenticateFull(request, deps)
  if (!auth.ok) return apiErrorResponse(auth.error, requestId)
  if (!isId(id)) return apiErrorResponse(DOMAIN_NOT_FOUND, requestId)
  const removed = await deps.domains.remove(auth.key.accountId, auth.key.keyId, id)
  if (!removed.ok) {
    logger.info(
      { requestId, keyId: auth.key.keyId, refused: removed.code },
      'v1 domain removal refused',
    )
    return apiErrorResponse(domainApiError(removed), requestId)
  }
  if (removed.needsRelease) await settleDomainNow({ accountId: auth.key.accountId, domainId: id })
  logger.info({ requestId, keyId: auth.key.keyId, domainId: id }, 'v1 domain removed')
  return apiJson({ object: 'domain', id, deleted: true }, 200, requestId)
}
