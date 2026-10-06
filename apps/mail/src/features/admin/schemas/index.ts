import { z } from 'zod'

/**
 * What Mail's admin actions take (MAIL-SPEC §10). Each carries the dialog's
 * request key, so a lost answer is replayed rather than acted on twice; a
 * reason is 10–500 characters, as SQL holds it (admin_reason_problem).
 */

const requestKey = z.uuid()
const accountId = z.uuid()
export const reason = z
  .string()
  .trim()
  .min(10, 'Give a reason of at least 10 characters.')
  .max(500, 'Keep the reason under 500 characters.')
const code = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.')

export const reviewSchema = z.object({ accountId, reason, requestKey })

export const pauseSchema = reviewSchema

export const resumeSchema = z.object({
  accountId,
  /** The open pause finding the admin read (MR5); null when none is open. */
  findingId: z.number().int().positive().nullable(),
  reason,
  requestKey,
  code,
})

/** A cap in recipients; null keeps the plan's. */
const cap = z.number().int().min(1).max(10_000_000).nullable()

export const capsSchema = z.object({
  accountId,
  dailyCap: cap,
  monthlyCap: cap,
  reason,
  requestKey,
  code,
})
