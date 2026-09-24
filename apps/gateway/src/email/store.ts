import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env'

/**
 * The email outbox as the gateway sees it (migration 31): claim what is due
 * on one side, record what happened. Every write is fenced by the worker
 * that claimed the email.
 */

export type QueuedEmail = {
  id: string
  kind: string
  toEmail: string
  data: Record<string, unknown>
  attempts: number
  testMode: boolean
}

export type DeliveryDue = { id: string; messageId: string; sentAt: Date }

export interface EmailStore {
  claim(worker: string, testMode: boolean, limit: number): Promise<QueuedEmail[]>
  sent(id: string, worker: string, messageId: string | null, version: string): Promise<boolean>
  failed(id: string, worker: string, error: string, permanent: boolean): Promise<boolean>
  skipped(id: string, worker: string, reason: string): Promise<boolean>
  deliveryDue(limit: number): Promise<DeliveryDue[]>
  recordDelivery(id: string, status: 'delivered' | 'bounced' | 'deferred' | null): Promise<void>
}

export function createEmailStore(
  client: SupabaseClient<Database> = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ),
): EmailStore {
  async function flag(result: PromiseLike<{ data: unknown; error: { message: string } | null }>) {
    const { data, error } = await result
    if (error) throw new Error(error.message)
    return data === true
  }

  return {
    async claim(worker, testMode, limit) {
      const { data, error } = await client.rpc('claim_emails', {
        p_worker: worker,
        p_test_mode: testMode,
        p_limit: limit,
      })
      if (error) throw new Error(error.message)
      return (data ?? []).map((row) => ({
        id: row.id,
        kind: row.kind,
        toEmail: row.to_email,
        data: (row.data ?? {}) as Record<string, unknown>,
        attempts: row.attempts,
        testMode: row.test_mode,
      }))
    },
    sent: (id, worker, messageId, version) =>
      flag(
        client.rpc('mark_email_sent', {
          p_id: id,
          p_worker: worker,
          // Brevo always returns one; the column only needs a value to look for.
          p_message_id: messageId ?? '',
          p_template_version: version,
        }),
      ),
    failed: (id, worker, error, permanent) =>
      flag(
        client.rpc('mark_email_failed', {
          p_id: id,
          p_worker: worker,
          p_error: error,
          p_permanent: permanent,
        }),
      ),
    skipped: (id, worker, reason) =>
      flag(client.rpc('mark_email_skipped', { p_id: id, p_worker: worker, p_reason: reason })),
    async deliveryDue(limit) {
      const { data, error } = await client.rpc('emails_for_delivery_check', { p_limit: limit })
      if (error) throw new Error(error.message)
      return (data ?? [])
        .filter((row) => row.provider_message_id)
        .map((row) => ({
          id: row.id,
          messageId: row.provider_message_id,
          sentAt: new Date(row.sent_at),
        }))
    },
    async recordDelivery(id, status) {
      const { error } = await client.rpc('record_email_delivery', {
        p_id: id,
        p_status: status as string,
      })
      if (error) throw new Error(error.message)
    },
  }
}
