import { apiDeps } from '@/features/api/deps'
import { runApi } from '@/features/api/lib/handler'
import { getEmail } from '@/features/emails/api/get-email'

/** GET /api/v1/emails/{id} — one email's status (MAIL-SPEC §6). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return runApi('GET /v1/emails/:id', apiDeps, (deps, requestId) =>
    getEmail(request, id, deps, requestId),
  )
}
