'use server'

import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { reviewScreeningSchema } from '@/features/admin/schemas/screening'
import { adminAction } from '@/lib/safe-action'

/**
 * Reviewing a screened name (migration 73; docs: "Making AI the core of
 * MyDomainsHub", feature 6): an operator says whether a name the screening
 * passed to a person looks fine or is abuse, and why. The wrapper records
 * it once and closes the warning; it never touches the order — anything
 * done about abuse is done by a person, separately.
 */
export const reviewScreening = adminAction('order.review_screening', reviewScreeningSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const { data, error } = await ctx.db.rpc('admin_review_screening', {
      p_order_item_id: parsedInput.orderItemId,
      p_decision: parsedInput.decision,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    })
    if (error) throw adminAccessError(error.message)
    return toAdminResult(data)
  },
)
