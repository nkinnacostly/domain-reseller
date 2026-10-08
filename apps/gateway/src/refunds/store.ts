import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { env } from '../env'

/**
 * The refund queue, as the worker sees it. Every method is one database
 * function (migrations 15, 16 and 18), which also enforce the money rules —
 * the worker cannot refund more than a charge took however it misbehaves.
 * Every call after the claim names the worker, and is refused once the claim
 * has passed to another (migration 18): a stalled worker cannot act on a
 * refund someone else now holds.
 */

const claimSchema = z.object({
  id: z.uuid(),
  action: z.enum(['send', 'recover', 'poll']),
  reason: z.enum([
    'registration_failed',
    'renewal_failed',
    'transfer_failed',
    // FR-SSL-3 (migration 38): a certificate the supplier would not sell. The
    // order job fails a line only on a refusal, or before anything was sent —
    // never after an unknown answer (N3) — so there is nothing to read first.
    'ssl_failed',
    'duplicate_charge',
    'overpayment',
    'underpayment',
    'empty_order',
    // Migration 61 (security audit, 8 Oct 2026): refunded whole, nothing registered.
    'late_payment',
    'over_limit',
  ]),
  amount_kobo: z.coerce.number().int().positive(),
  attempts: z.number().int().nonnegative(),
  test_mode: z.boolean(),
  provider_refund_id: z.string().nullable(),
  provider_called_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  transaction_id: z.string().min(1),
  flw_ref: z.string().nullable(),
  charged_kobo: z.coerce.number().int().positive(),
  charged_at: z.string(),
  order_tx_ref: z.string().min(1),
  order_number: z.string(),
  domain_name: z.string().nullable(),
  held_by_other_account: z.boolean(),
  renewal_baseline: z.string().nullable().optional(),
  renewal_years: z.number().int().positive().nullable().optional(),
  known_provider_refund_ids: z.array(z.string()),
  other_refunds_kobo: z.coerce.number().int().nonnegative(),
})

export type ClaimedRefund = {
  id: string
  action: 'send' | 'recover' | 'poll'
  reason: z.infer<typeof claimSchema>['reason']
  amountKobo: number
  /** Claims so far, this one included. */
  attempts: number
  testMode: boolean
  providerRefundId: string | null
  /** When this attempt called Flutterwave; null if it never did. */
  providerCalledAt: string | null
  submittedAt: string | null
  /** Flutterwave's id for the charge the money goes back to. */
  transactionId: string
  flwRef: string | null
  chargedKobo: number
  chargedAt: string
  /** The order's reference: the charge at Flutterwave must carry it. */
  orderTxRef: string
  orderNumber: string
  domainName: string | null
  /** Another account here holds the name — so the registry's record is theirs, not this line's. */
  heldByOtherAccount: boolean
  /** A renewal refund: the registry's expiry before our Renew call, or null if none was made. */
  renewalBaseline: string | null
  renewalYears: number | null
  /** Refunds at Flutterwave that our rows account for: other rows', and every failed one. */
  knownProviderRefundIds: string[]
  /** What our other refunds on this charge add up to. */
  otherRefundsKobo: number
}

export function toClaimedRefund(raw: unknown): ClaimedRefund {
  const row = claimSchema.parse(raw)
  return {
    id: row.id,
    action: row.action,
    reason: row.reason,
    amountKobo: row.amount_kobo,
    attempts: row.attempts,
    testMode: row.test_mode,
    providerRefundId: row.provider_refund_id,
    providerCalledAt: row.provider_called_at,
    submittedAt: row.submitted_at,
    transactionId: row.transaction_id,
    flwRef: row.flw_ref,
    chargedKobo: row.charged_kobo,
    chargedAt: row.charged_at,
    orderTxRef: row.order_tx_ref,
    orderNumber: row.order_number,
    domainName: row.domain_name,
    heldByOtherAccount: row.held_by_other_account,
    renewalBaseline: row.renewal_baseline ?? null,
    renewalYears: row.renewal_years ?? null,
    knownProviderRefundIds: row.known_provider_refund_ids,
    otherRefundsKobo: row.other_refunds_kobo,
  }
}

export interface RefundStore {
  claim(worker: string, testMode: boolean, leaseSeconds: number): Promise<ClaimedRefund | null>
  /** Immediately before the refund request goes out (migration 16). */
  noteProviderCall(refundId: string, worker: string): Promise<void>
  submitted(
    refundId: string,
    worker: string,
    providerRefundId: string,
    providerStatus: string,
    checkAfterSeconds: number,
  ): Promise<void>
  complete(
    refundId: string,
    worker: string,
    providerRefundId: string,
    providerStatus: string,
  ): Promise<void>
  /** `providerRefundId`: money did move, so its reference is kept with the stop. */
  fail(
    refundId: string,
    worker: string,
    code: string,
    message: string,
    needsAttention: boolean,
    providerRefundId?: string,
  ): Promise<void>
  /** `sent` false: nothing reached Flutterwave, back to the queue. True: stay in flight. */
  reschedule(
    refundId: string,
    worker: string,
    delaySeconds: number,
    code: string,
    message: string,
    sent: boolean,
  ): Promise<void>
}

export function createRefundStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): RefundStore {
  async function rpc(result: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await result
    if (error) throw new Error(error.message)
  }

  return {
    async claim(worker, testMode, leaseSeconds) {
      const { data, error } = await client.rpc('claim_refund', {
        p_worker: worker,
        p_test_mode: testMode,
        p_lease_seconds: leaseSeconds,
      })
      if (error) throw new Error(error.message)
      return data ? toClaimedRefund(data) : null
    },
    noteProviderCall: (refundId, worker) =>
      rpc(client.rpc('note_refund_provider_call', { p_refund_id: refundId, p_worker: worker })),
    submitted: (refundId, worker, providerRefundId, providerStatus, checkAfterSeconds) =>
      rpc(
        client.rpc('record_refund_submitted', {
          p_refund_id: refundId,
          p_worker: worker,
          p_provider_refund_id: providerRefundId,
          p_provider_status: providerStatus,
          p_check_after_seconds: checkAfterSeconds,
        }),
      ),
    complete: (refundId, worker, providerRefundId, providerStatus) =>
      rpc(
        client.rpc('complete_refund', {
          p_refund_id: refundId,
          p_worker: worker,
          p_provider_refund_id: providerRefundId,
          p_provider_status: providerStatus,
        }),
      ),
    fail: (refundId, worker, code, message, needsAttention, providerRefundId) =>
      rpc(
        client.rpc('fail_refund', {
          p_refund_id: refundId,
          p_worker: worker,
          p_code: code,
          p_message: message,
          p_needs_attention: needsAttention,
          ...(providerRefundId ? { p_provider_refund_id: providerRefundId } : {}),
        }),
      ),
    reschedule: (refundId, worker, delaySeconds, code, message, sent) =>
      rpc(
        client.rpc('reschedule_refund', {
          p_refund_id: refundId,
          p_worker: worker,
          p_delay_seconds: delaySeconds,
          p_code: code,
          p_message: message,
          p_sent: sent,
        }),
      ),
  }
}
