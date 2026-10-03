'use server'

import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { requeueEmailSchema } from '@/features/admin/schemas/emails'
import { adminAction } from '@/lib/safe-action'

/**
 * "Send again" for a failed email (docs/ADMIN-SPEC.md §3.1.2, §5.2 B11):
 * `email.requeue`, operator, standard tier. One audited wrapper,
 * `admin_requeue_email`, called with the session client, puts the email
 * back in the queue; the gateway sends it (CLAUDE.md §15 — no email is
 * sent from the web). The wrapper refuses an email that is not failed, that
 * bounced or that was reported as spam, and holds a test admin to an e2e
 * account's test email (D15); it records its refusals as well as its
 * successes. Nothing here logs the email or who it was for (N13).
 */

type Answer = { data: unknown; error: { message: string } | null }

/** The wrapper's answer; an error that is not a refusal is thrown, so the dialog keeps its key. */
function answered({ data, error }: Answer): AdminResult {
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

export const requeueEmail = adminAction('email.requeue', requeueEmailSchema).action(
  async ({ parsedInput, ctx }) =>
    answered(
      await ctx.db.rpc('admin_requeue_email', {
        p_email_id: parsedInput.emailId,
        // SQL stores an empty reason as none.
        p_reason: parsedInput.reason ?? '',
        p_request_key: parsedInput.requestKey,
      }),
    ),
)
