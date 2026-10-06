import { apiDeps } from '@/features/api/deps'
import { runApi } from '@/features/api/lib/handler'
import { sendEmail } from '@/features/emails/api/send-email'

/** POST /api/v1/emails — queue one email (MAIL-SPEC §6). */
export function POST(request: Request) {
  return runApi('POST /v1/emails', apiDeps, (deps, requestId) =>
    sendEmail(request, deps, requestId),
  )
}
