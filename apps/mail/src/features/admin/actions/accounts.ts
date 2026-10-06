'use server'

import { adminAction, adminMoneyAction } from '@/features/admin/lib/action-client'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { capsSchema, pauseSchema, resumeSchema, reviewSchema } from '@/features/admin/schemas'
import { applyDueTenantActions } from '@/features/safety/queries/apply'
import { logger } from '@/lib/logger'
import type { MailSessionClient } from '@/lib/supabase/server'

/**
 * Mail's admin actions (MAIL-SPEC §7.2, §7.4, §10, MR5). Each is one audited
 * `admin_mail_*` wrapper, called with the admin's own session: the wrapper
 * applies the tier, the test-admin rule and the business checks, and records
 * refusals as well as successes. A pause or resume that changes SES's side
 * is applied straight after with the manager key; should that fail, it stays
 * queued, our own gate holds, and the alert says so.
 */

type Wrapper =
  | 'admin_mail_approve_account'
  | 'admin_mail_reject_account'
  | 'admin_mail_pause_account'
  | 'admin_mail_resume_account'
  | 'admin_mail_override_caps'

async function callWrapper(
  db: MailSessionClient,
  fn: Wrapper,
  args: Record<string, unknown>,
): Promise<AdminResult> {
  const { data, error } = await db.schema('public').rpc(fn as never, args as never)
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

/** SES's side, now: the request is queued already, so a failure here changes nothing. */
async function applySesSide(result: AdminResult): Promise<void> {
  const tenantActionId = result.ok ? result.after?.tenantActionId : null
  if (typeof tenantActionId !== 'number') return
  try {
    await applyDueTenantActions()
  } catch (error) {
    logger.warn(
      { action: tenantActionId, err: error instanceof Error ? error.message : 'error' },
      'the SES side of a pause or resume waits for the next run',
    )
  }
}

export const approveAccount = adminAction('mail.approve', reviewSchema).action(
  async ({ parsedInput, ctx }) =>
    callWrapper(ctx.db, 'admin_mail_approve_account', {
      p_account_id: parsedInput.accountId,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    }),
)

export const rejectAccount = adminAction('mail.reject', reviewSchema).action(
  async ({ parsedInput, ctx }) =>
    callWrapper(ctx.db, 'admin_mail_reject_account', {
      p_account_id: parsedInput.accountId,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    }),
)

export const pauseAccount = adminAction('mail.pause', pauseSchema).action(
  async ({ parsedInput, ctx }) => {
    const result = await callWrapper(ctx.db, 'admin_mail_pause_account', {
      p_account_id: parsedInput.accountId,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    })
    await applySesSide(result)
    return result
  },
)

export const resumeAccount = adminMoneyAction('mail.resume', resumeSchema).action(
  async ({ parsedInput, ctx }) => {
    const result = await callWrapper(ctx.db, 'admin_mail_resume_account', {
      p_account_id: parsedInput.accountId,
      p_finding_id: parsedInput.findingId,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    })
    await applySesSide(result)
    return result
  },
)

export const overrideCaps = adminMoneyAction('mail.cap_override', capsSchema).action(
  async ({ parsedInput, ctx }) =>
    callWrapper(ctx.db, 'admin_mail_override_caps', {
      p_account_id: parsedInput.accountId,
      p_daily_cap: parsedInput.dailyCap,
      p_monthly_cap: parsedInput.monthlyCap,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    }),
)
