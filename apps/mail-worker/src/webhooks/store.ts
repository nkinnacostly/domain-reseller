import { z } from 'zod'
import { type MailClient, StoreError } from '../store'

/**
 * The webhook loop's database boundary (migration 49), with the secret key:
 * `claim_webhook_deliveries` (FOR UPDATE SKIP LOCKED; never a test account's
 * unless asked for by its id) and `record_webhook_attempt` (only the worker
 * holding the claim). The signing secret arrives sealed and is opened only
 * in memory, just before signing.
 */

export const claimedDeliverySchema = z.object({
  id: z.number().int().positive(),
  webhookId: z.uuid(),
  accountId: z.uuid(),
  url: z.string().min(1),
  secretSealed: z.string().min(1),
  messageId: z.string().regex(/^msg_[0-9a-f]{32}$/),
  eventType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  attempt: z.number().int().min(1),
})

export type ClaimedDelivery = z.infer<typeof claimedDeliverySchema>

/** A claimed row we could not read: only its id, so it can be failed rather than left hanging. */
export type UnreadableDelivery = { id: number; unreadable: true }

/** What one attempt came to: an HTTP status, or a code for why there was none. */
export type Attempt = {
  status: number | null
  error: string | null
  response: string | null
  durationMs: number | null
}

export type WebhookStore = {
  claim(
    worker: string,
    limit: number,
    accountId?: string,
  ): Promise<(ClaimedDelivery | UnreadableDelivery)[]>
  record(deliveryId: number, worker: string, attempt: Attempt): Promise<boolean>
}

const recorded = z.object({ ok: z.boolean() })

export function createWebhookStore(client: MailClient): WebhookStore {
  return {
    async claim(worker, limit, accountId) {
      const { data, error } = await client.rpc('claim_webhook_deliveries', {
        p_worker: worker,
        p_limit: limit,
        ...(accountId ? { p_account_id: accountId } : {}),
      })
      if (error) throw new StoreError('claim_webhook_deliveries', error.code ?? null)
      if (!Array.isArray(data))
        throw new StoreError('claim_webhook_deliveries', 'unexpected_answer')
      return data.map((row): ClaimedDelivery | UnreadableDelivery => {
        const parsed = claimedDeliverySchema.safeParse(row)
        if (parsed.success) return parsed.data
        const id = z.object({ id: z.number().int().positive() }).safeParse(row)
        if (!id.success) throw new StoreError('claim_webhook_deliveries', 'unexpected_answer')
        return { id: id.data.id, unreadable: true }
      })
    },

    async record(deliveryId, worker, attempt) {
      const { data, error } = await client.rpc('record_webhook_attempt', {
        p_delivery_id: deliveryId,
        p_worker: worker,
        ...(attempt.status !== null ? { p_status_code: attempt.status } : {}),
        ...(attempt.error ? { p_error: attempt.error } : {}),
        ...(attempt.response ? { p_response: attempt.response } : {}),
        ...(attempt.durationMs !== null ? { p_duration_ms: attempt.durationMs } : {}),
      })
      if (error) throw new StoreError('record_webhook_attempt', error.code ?? null)
      const answer = recorded.safeParse(data)
      if (!answer.success) throw new StoreError('record_webhook_attempt', 'unexpected_answer')
      return answer.data.ok
    },
  }
}
