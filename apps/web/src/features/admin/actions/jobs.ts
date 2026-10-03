'use server'

import { z } from 'zod'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import {
  codeSchema,
  reasonSchema,
  requestKeySchema,
  uuidSchema,
} from '@/features/admin/schemas/common'
import { type AdminContext, adminMoneyAction } from '@/lib/safe-action'

/**
 * The queue's buttons (docs/ADMIN-SPEC.md §5.2 B4). Each is a money action
 * (D6): the dialog's code is verified against this session's own factor
 * before the wrapper is called, and the wrapper — admin_retry_job,
 * admin_fail_job and their certificate twins — applies the tier, the guards
 * and the audit row in SQL. A job's state moves only through the queue
 * functions they call (retry_job, fail_job); nothing here writes a table.
 */

const jobInput = z.object({
  jobId: uuidSchema,
  reason: reasonSchema,
  requestKey: requestKeySchema,
  code: codeSchema,
})

type JobInput = z.output<typeof jobInput>

type Wrapper = 'admin_retry_job' | 'admin_fail_job' | 'admin_retry_ssl_job' | 'admin_fail_ssl_job'

async function callWrapper(ctx: AdminContext, wrapper: Wrapper, input: JobInput) {
  const { data, error } = await ctx.db.rpc(wrapper, {
    p_job_id: input.jobId.toLowerCase(),
    p_reason: input.reason,
    p_request_key: input.requestKey,
  })
  // A recognised code is a refusal (new key); anything else may have committed (same key).
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

/** Back to the queue: the worker reads the registry (or the charge) first, and never buys twice. */
export const retryJob = adminMoneyAction('job.retry', jobInput).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> =>
    callWrapper(ctx, 'admin_retry_job', parsedInput),
)

/** Ends a job that needs a person, after the read SQL requires; a failed line queues its refund. */
export const failJob = adminMoneyAction('job.fail', jobInput).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> =>
    callWrapper(ctx, 'admin_fail_job', parsedInput),
)

export const retrySslJob = adminMoneyAction('ssl_job.retry', jobInput).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> =>
    callWrapper(ctx, 'admin_retry_ssl_job', parsedInput),
)

/** Only an order never sent to the supplier is failed (N3); SQL refuses the rest. */
export const failSslJob = adminMoneyAction('ssl_job.fail', jobInput).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> =>
    callWrapper(ctx, 'admin_fail_ssl_job', parsedInput),
)
