import { apiDeps } from '@/features/api/deps'
import { otherMethods, runApi } from '@/features/api/lib/handler'
import { cancelEmail } from '@/features/emails/api/change-email'

/** POST /api/v1/emails/{id}/cancel — cancel an email still waiting (MAIL-SPEC §3.1, §6). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return runApi('POST /v1/emails/:id/cancel', apiDeps, (deps, requestId) =>
    cancelEmail(request, id, deps, requestId),
  )
}

export const { GET, PATCH, PUT, DELETE } = otherMethods(['POST'])
