'use server'

import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { redactReasonSchema } from '@/features/admin/schemas/audit'
import { adminMoneyAction } from '@/lib/safe-action'

/**
 * The audit log's one change (docs/ADMIN-SPEC.md §2.5, §5.2 B14): the owner
 * removes the typed reason from an entry — a reason that held personal
 * details, say. A money action: the dialog's code is checked against this
 * session's factor first (D6). `admin_redact_reason` nulls the reason and
 * stamps when, touches nothing else (who, what, when and the amounts stay),
 * and records the removal as its own entry, refusals included. Only the
 * owner may; SQL refuses anyone else, and a test administrator always.
 */
export const redactAuditReason = adminMoneyAction('audit.redact', redactReasonSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const { data, error } = await ctx.db.rpc('admin_redact_reason', {
      p_audit_id: parsedInput.auditId,
      p_why: parsedInput.why,
      p_request_key: parsedInput.requestKey,
    })
    if (error) throw adminAccessError(error.message)
    return toAdminResult(data)
  },
)
