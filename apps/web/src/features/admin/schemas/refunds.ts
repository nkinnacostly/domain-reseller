import { z } from 'zod'
import { CANCEL_NOTE_MAX } from '@/features/admin/lib/refunds-copy'
import { FLW_REFUND_ID, INCIDENT_OUTCOMES } from '@/features/admin/lib/refunds-rules'
import {
  bigintIdSchema,
  codeSchema,
  reasonSchema,
  requestKeySchema,
  uuidSchema,
} from '@/features/admin/schemas/common'

/**
 * The refund and incident actions' inputs (ADMIN-SPEC §3.1.2, §5.2 B3),
 * validated before anything else runs. Every money action carries the
 * dialog's code (D6). Ticked boxes travel as booleans: the wrapper is what
 * refuses a missing one, and records that it did.
 */

const moneyWrite = z.object({ requestKey: requestKeySchema, code: codeSchema })

export const approveRefundSchema = moneyWrite.extend({
  refundId: uuidSchema,
  reason: reasonSchema,
})

export const retryRefundSchema = approveRefundSchema.extend({
  checkedProvider: z.boolean(),
})

export const cancelRefundSchema = moneyWrite.extend({
  refundId: uuidSchema,
  note: z
    .string()
    .trim()
    .min(10, 'Say what happened in at least 10 characters.')
    .max(CANCEL_NOTE_MAX, `Keep it under ${CANCEL_NOTE_MAX} characters.`),
  noMoneyMoved: z.boolean(),
  checkedProvider: z.boolean(),
})

export const flwRefundIdSchema = z
  .string()
  .trim()
  .regex(FLW_REFUND_ID, "That isn't a Flutterwave refund id.")

export const recordManualRefundSchema = moneyWrite.extend({
  refundId: uuidSchema,
  checkId: bigintIdSchema,
  flwRefundId: flwRefundIdSchema,
  checkedProvider: z.boolean(),
  reason: reasonSchema,
})

/** An incident where nothing is owed: looked at, no evidence, no code. */
export const resolveIncidentSchema = z.object({
  incidentId: bigintIdSchema,
  reason: reasonSchema,
  requestKey: requestKeySchema,
})

/** An incident where money is owed: what settled it, and its evidence (§3.1.2). */
export const resolveMoneyIncidentSchema = moneyWrite
  .extend({
    incidentId: bigintIdSchema,
    outcome: z.enum(INCIDENT_OUTCOMES),
    refundId: uuidSchema.optional(),
    checkId: bigintIdSchema.optional(),
    confirmed: z.boolean(),
    reason: reasonSchema,
  })
  .refine((input) => input.outcome !== 'refund_completed' || input.refundId !== undefined, {
    message: 'Pick the refund that completed.',
    path: ['refundId'],
  })
  .refine((input) => input.outcome !== 'flw_refund_verified' || input.checkId !== undefined, {
    message: 'Check the Flutterwave refund first.',
    path: ['checkId'],
  })
