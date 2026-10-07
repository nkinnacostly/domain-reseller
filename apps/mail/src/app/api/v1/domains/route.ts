import { connection } from 'next/server'
import { otherMethods, runApi } from '@/features/api/lib/handler'
import { domainApiDeps } from '@/features/domains/api/deps'
import { createDomainApi, listDomainsApi } from '@/features/domains/api/handlers'

/** GET /api/v1/domains — the account's domains (MAIL-SPEC §5, §6). */
export async function GET(request: Request) {
  await connection()
  return runApi('GET /v1/domains', domainApiDeps, (deps, requestId) =>
    listDomainsApi(request, deps, requestId),
  )
}

/** POST /api/v1/domains — add one; answers its DNS records. */
export function POST(request: Request) {
  return runApi('POST /v1/domains', domainApiDeps, (deps, requestId) =>
    createDomainApi(request, deps, requestId),
  )
}

export const { PATCH, PUT, DELETE } = otherMethods(['GET', 'POST'])
