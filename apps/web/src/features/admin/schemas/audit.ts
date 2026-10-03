import { z } from 'zod'
import {
  bigintIdSchema,
  codeSchema,
  reasonSchema,
  requestKeySchema,
} from '@/features/admin/schemas/common'

/**
 * "Redact reason" (docs/ADMIN-SPEC.md §2.5, §5.2 B14): which entry, why —
 * under the same rules as any reason, and itself kept in the log — the
 * dialog's request key, and the code from the authenticator app (D6).
 */
export const redactReasonSchema = z.object({
  auditId: bigintIdSchema,
  why: reasonSchema,
  requestKey: requestKeySchema,
  code: codeSchema,
})
