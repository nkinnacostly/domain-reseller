import { apiDeps } from '@/features/api/deps'
import { revokeApiKey } from '@/features/api/handlers/api-keys'
import { otherMethods, runApi } from '@/features/api/lib/handler'

/** DELETE /api/v1/api-keys/{id} — revoke a key at once (MAIL-SPEC §6, MR7). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return runApi('DELETE /v1/api-keys/:id', apiDeps, (deps, requestId) =>
    revokeApiKey(request, id, deps, requestId),
  )
}

export const { GET, POST, PATCH, PUT } = otherMethods(['DELETE'])
