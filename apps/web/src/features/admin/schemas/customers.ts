import { z } from 'zod'
import { SEARCH_TOO_SHORT } from '@/features/admin/lib/customers-copy'
import { optionalReasonSchema, requestKeySchema, uuidSchema } from '@/features/admin/schemas/common'

/**
 * The customers actions' inputs (docs/ADMIN-SPEC.md §3.1.2, §5.2 B8),
 * validated before the session is asked anything. A search is an exact
 * email, order number or domain, 3–254 characters as SQL takes it; it
 * travels in the request body only (N13, §1).
 */

export const findCustomersSchema = z.object({
  query: z
    .string()
    .trim()
    .min(3, SEARCH_TOO_SHORT)
    .max(254, 'That is longer than any email address, order number or domain.'),
})

/** A reveal's reason is optional (§5.2); its key makes a lost answer replay, not repeat. */
export const revealCustomerSchema = z.object({
  userId: uuidSchema,
  reason: optionalReasonSchema,
  requestKey: requestKeySchema,
})
