import { otherMethods, runApi } from '@/features/api/lib/handler'
import { domainApiDeps } from '@/features/domains/api/deps'
import { deleteDomainApi, getDomainApi } from '@/features/domains/api/handlers'

type Context = { params: Promise<{ id: string }> }

/** GET /api/v1/domains/{id} — one domain, its state and its DNS records (MAIL-SPEC §5, §6). */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params
  return runApi('GET /v1/domains/:id', domainApiDeps, (deps, requestId) =>
    getDomainApi(request, id, deps, requestId),
  )
}

/** DELETE /api/v1/domains/{id} — refused while emails from it wait to be sent. */
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params
  return runApi('DELETE /v1/domains/:id', domainApiDeps, (deps, requestId) =>
    deleteDomainApi(request, id, deps, requestId),
  )
}

export const { POST, PATCH, PUT } = otherMethods(['GET', 'DELETE'])
