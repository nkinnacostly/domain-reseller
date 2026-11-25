import { z } from 'zod'
import { reasonSchema, requestKeySchema, uuidSchema } from '@/features/admin/schemas/common'

/** Migration 73: an operator's review of a name the screening passed to a person. */
export const reviewScreeningSchema = z.object({
  orderItemId: uuidSchema,
  decision: z.enum(['fine', 'abuse']),
  reason: reasonSchema,
  requestKey: requestKeySchema,
})
