import type { MailDatabase } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

/**
 * The worker's database boundary (migration 44), with the secret key, whose
 * only reach into schema `mail` is the functions granted to service_role:
 * claim_sends (FOR UPDATE SKIP LOCKED, the gate asked again), and
 * record_send_result (only the worker holding the claim). Heartbeats go to
 * the shop's `public.record_heartbeat`, where the admin's alerts read them.
 */

export type MailClient = SupabaseClient<MailDatabase, 'mail'>

const attachment = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
  content_type: z.string().min(1),
})

export const claimedEmailSchema = z.object({
  id: z.number().int().positive(),
  publicId: z.uuid(),
  accountShortId: z.string(),
  tenant: z.string(),
  configurationSet: z.string(),
  from: z.string().min(1),
  to: z.array(z.string()).min(1),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string().min(1),
  tags: z.array(z.object({ name: z.string(), value: z.string() })),
  recipientCount: z.number().int().min(1),
  attempt: z.number().int().min(1),
  html: z.string().nullable(),
  text: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  attachments: z.array(attachment),
})

export type ClaimedEmail = z.infer<typeof claimedEmailSchema>

/** A claimed row we could not read: only its id, so it can be failed rather than left hanging. */
export type UnreadableClaim = { id: number; unreadable: true }

export type SendOutcome =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'throttled'; code: string | null; retryAfterSeconds: number }
  | { outcome: 'retry'; code: string | null }
  | { outcome: 'failed'; code: string }

export type MailStore = {
  claim(
    worker: string,
    limit: number,
    paidOnly: boolean,
  ): Promise<(ClaimedEmail | UnreadableClaim)[]>
  record(emailId: number, worker: string, result: SendOutcome): Promise<boolean>
  heartbeat(name: string, detail: Record<string, unknown>): Promise<void>
}

export class StoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`mail store: ${operation} failed${code ? ` (${code})` : ''}`)
    this.name = 'StoreError'
  }
}

const recorded = z.object({ ok: z.boolean() })

export function createMailStore(client: MailClient): MailStore {
  return {
    async claim(worker, limit, paidOnly) {
      const { data, error } = await client.rpc('claim_sends', {
        p_worker: worker,
        p_limit: limit,
        p_paid_only: paidOnly,
      })
      if (error) throw new StoreError('claim_sends', error.code ?? null)
      if (!Array.isArray(data)) throw new StoreError('claim_sends', 'unexpected_answer')
      return data.map((row): ClaimedEmail | UnreadableClaim => {
        const parsed = claimedEmailSchema.safeParse(row)
        if (parsed.success) return parsed.data
        const id = z.object({ id: z.number().int().positive() }).safeParse(row)
        if (!id.success) throw new StoreError('claim_sends', 'unexpected_answer')
        return { id: id.data.id, unreadable: true }
      })
    },

    async record(emailId, worker, result) {
      const args = {
        p_email_id: emailId,
        p_worker: worker,
        p_outcome: result.outcome,
        ...(result.outcome === 'sent' ? { p_message_id: result.messageId } : {}),
        ...('code' in result && result.code ? { p_error_code: result.code } : {}),
        ...(result.outcome === 'throttled'
          ? { p_retry_after_seconds: result.retryAfterSeconds }
          : {}),
      }
      const { data, error } = await client.rpc('record_send_result', args)
      if (error) throw new StoreError('record_send_result', error.code ?? null)
      const answer = recorded.safeParse(data)
      if (!answer.success) throw new StoreError('record_send_result', 'unexpected_answer')
      return answer.data.ok
    },

    async heartbeat(name, detail) {
      const { error } = await client
        .schema('public')
        .rpc('record_heartbeat', { p_name: name, p_test_mode: false, p_detail: detail as never })
      if (error) throw new StoreError('record_heartbeat', error.code ?? null)
    },
  }
}
