import { apiDeps } from '@/features/api/deps'
import { otherMethods, runApi } from '@/features/api/lib/handler'
import { rescheduleEmail } from '@/features/emails/api/change-email'
import { getEmail } from '@/features/emails/api/get-email'

type Context = { params: Promise<{ id: string }> }

/** GET /api/v1/emails/{id} — one email's status (MAIL-SPEC §6). */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params
  return runApi('GET /v1/emails/:id', apiDeps, (deps, requestId) =>
    getEmail(request, id, deps, requestId),
  )
}

/** PATCH /api/v1/emails/{id} — reschedule an email still waiting (§3.1, §6). */
export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params
  return runApi('PATCH /v1/emails/:id', apiDeps, (deps, requestId) =>
    rescheduleEmail(request, id, deps, requestId),
  )
}

export const { POST, PUT, DELETE } = otherMethods(['GET', 'PATCH'])
