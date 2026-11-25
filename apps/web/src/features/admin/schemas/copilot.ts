import { z } from 'zod'
import { bigintIdSchema, requestKeySchema } from '@/features/admin/schemas/common'

/** Migration 74: one alert, explained or drafted into a supplier ticket. */
export const alertHelpSchema = z.object({
  alertId: bigintIdSchema,
  mode: z.enum(['explain', 'ticket']),
  /** Where the alert is worked, in the list's words ("Supplier ledger"): context for the model only. */
  page: z.string().regex(/^[A-Za-z ]{2,30}$/),
  requestKey: requestKeySchema,
})
