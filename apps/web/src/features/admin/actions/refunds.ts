'use server'

import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import {
  approveRefundSchema,
  cancelRefundSchema,
  recordManualRefundSchema,
  retryRefundSchema,
} from '@/features/admin/schemas/refunds'
import { adminMoneyAction } from '@/lib/safe-action'

/**
 * Refund decisions (ADMIN-SPEC §3.1.2, §5.2 B3). Each is a money action: the
 * dialog's code is verified against this session's factor before SQL sees
 * anything (D6), then one `admin_*` wrapper is called with the session
 * client. The wrapper holds every guard — a refund is sent only to a charge
 * Flutterwave confirms, never twice, and a cancel means no money moved
 * (CLAUDE.md §15) — and records its refusals as well as its successes.
 */

type Answer = { data: unknown; error: { message: string } | null }

/** A wrapper's answer in words; an error that is not a refusal is thrown, so the dialog keeps its key. */
function answered({ data, error }: Answer): AdminResult {
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

/** Releases a held refund to the worker (`refund.approve`). */
export const approveRefund = adminMoneyAction('refund.approve', approveRefundSchema).action(
  async ({ parsedInput, ctx }) =>
    answered(
      await ctx.db.rpc('admin_approve_refund', {
        p_refund_id: parsedInput.refundId,
        p_reason: parsedInput.reason,
        p_request_key: parsedInput.requestKey,
      }),
    ),
)

/** Sends a failed, stuck or (owner) cancelled refund again (`refund.retry`). */
export const retryRefund = adminMoneyAction('refund.retry', retryRefundSchema).action(
  async ({ parsedInput, ctx }) =>
    answered(
      await ctx.db.rpc('admin_retry_refund', {
        p_refund_id: parsedInput.refundId,
        p_checked_provider: parsedInput.checkedProvider,
        p_reason: parsedInput.reason,
        p_request_key: parsedInput.requestKey,
      }),
    ),
)

/** Records that this money will not be sent back by us (`refund.cancel`, owner). */
export const cancelRefund = adminMoneyAction('refund.cancel', cancelRefundSchema).action(
  async ({ parsedInput, ctx }) =>
    answered(
      await ctx.db.rpc('admin_cancel_refund', {
        p_refund_id: parsedInput.refundId,
        p_no_money_moved: parsedInput.noMoneyMoved,
        p_checked_provider: parsedInput.checkedProvider,
        p_note: parsedInput.note,
        p_request_key: parsedInput.requestKey,
      }),
    ),
)

/**
 * Records a refund made from the Flutterwave dashboard (`refund.record_manual`),
 * backed by a check the gateway read from Flutterwave under 15 minutes ago (D23).
 */
export const recordManualRefund = adminMoneyAction(
  'refund.record_manual',
  recordManualRefundSchema,
).action(async ({ parsedInput, ctx }) =>
  answered(
    await ctx.db.rpc('admin_record_manual_refund', {
      p_refund_id: parsedInput.refundId,
      p_check_id: parsedInput.checkId,
      p_provider_refund_id: parsedInput.flwRefundId,
      p_checked_provider: parsedInput.checkedProvider,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    }),
  ),
)
