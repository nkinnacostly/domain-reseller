import { otherMethods, runApi } from '@/features/api/lib/handler'
import { domainApiDeps } from '@/features/domains/api/deps'
import { verifyDomainApi } from '@/features/domains/api/handlers'

/** POST /api/v1/domains/{id}/verify — read SES now, as "Check now" does (MAIL-SPEC §5). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return runApi('POST /v1/domains/:id/verify', domainApiDeps, (deps, requestId) =>
    verifyDomainApi(request, id, deps, requestId),
  )
}

export const { GET, PATCH, PUT, DELETE } = otherMethods(['POST'])
