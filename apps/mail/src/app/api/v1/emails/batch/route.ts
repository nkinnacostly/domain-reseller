import { apiDeps } from '@/features/api/deps'
import { otherMethods, runApi } from '@/features/api/lib/handler'
import { sendBatch } from '@/features/emails/api/send-batch'

/** POST /api/v1/emails/batch — up to 100 emails, all or none (MAIL-SPEC §6). */
export function POST(request: Request) {
  return runApi('POST /v1/emails/batch', apiDeps, (deps, requestId) =>
    sendBatch(request, deps, requestId),
  )
}

export const { GET, PATCH, PUT, DELETE } = otherMethods(['POST'])
