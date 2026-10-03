'use server'

import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { updateLimitsSchema } from '@/features/admin/schemas/settings'
import { adminMoneyAction } from '@/lib/safe-action'

/**
 * Save limits (docs/ADMIN-SPEC.md §3.1.2 `admin_update_ops_settings`, §5.2
 * B13): owner, money tier — the dialog's code is verified against this
 * session's factor before SQL sees anything (D6). Only the changed keys are
 * sent; the wrapper holds every bound again, and records a rise in a refund
 * limit or a shorter refund delay as `settings.refund_limit_raise`, which is
 * alerted. Nothing on the site caches these numbers, so nothing is expired.
 */
export const updateLimits = adminMoneyAction('settings.update', updateLimitsSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const changes = Object.fromEntries(
      Object.entries(parsedInput.changes).filter(([, value]) => value !== undefined),
    )
    const { data, error } = await ctx.db.rpc('admin_update_ops_settings', {
      p_changes: changes,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    })
    if (error) throw adminAccessError(error.message)
    return toAdminResult(data)
  },
)
