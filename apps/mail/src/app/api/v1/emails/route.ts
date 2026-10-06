import { apiDeps } from '@/features/api/deps'
import { otherMethods, runApi } from '@/features/api/lib/handler'
import { listEmails } from '@/features/emails/api/list-emails'
import { sendEmail } from '@/features/emails/api/send-email'

/** POST /api/v1/emails — queue one email (MAIL-SPEC §6). */
export function POST(request: Request) {
  return runApi('POST /v1/emails', apiDeps, (deps, requestId) =>
    sendEmail(request, deps, requestId),
  )
}

/** GET /api/v1/emails — the account's log, a page at a time (§6). */
export function GET(request: Request) {
  return runApi('GET /v1/emails', apiDeps, (deps, requestId) =>
    listEmails(request, deps, requestId),
  )
}

export const { PATCH, PUT, DELETE } = otherMethods(['GET', 'POST'])
