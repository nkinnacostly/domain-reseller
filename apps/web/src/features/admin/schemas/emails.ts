import { z } from 'zod'
import { optionalReasonSchema, requestKeySchema, uuidSchema } from '@/features/admin/schemas/common'

/**
 * "Send again"'s input (docs/ADMIN-SPEC.md §3.1.2, §5.2 B11), validated
 * before the session is asked anything. The reason is optional — the
 * wrapper takes none — and at most 500 characters; the request key makes a
 * lost answer replay rather than queue the email twice.
 */
export const requeueEmailSchema = z.object({
  emailId: uuidSchema,
  reason: optionalReasonSchema,
  requestKey: requestKeySchema,
})

export type RequeueEmailInput = z.input<typeof requeueEmailSchema>
