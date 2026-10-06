import 'server-only'

import type { EnqueueInput } from '@dr/shared/mail'
import { EMAIL_STATUSES, type SqlRefusal, sqlRefusalSchema } from '@dr/shared/mail'
import { z } from 'zod'
import type { MailServiceClient } from '@/lib/supabase/service'

/**
 * The v1 API's database boundary: three SQL functions (migration 44), called
 * with the secret key, whose answers are parsed here — a shape we did not
 * expect is an error, never a guess. Every rule (key, gate, caps,
 * idempotency, which account may read what) is in SQL.
 */

export class StoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`mail store: ${operation} failed${code ? ` (${code})` : ''}`)
    this.name = 'StoreError'
  }
}

const keyAccepted = z.object({
  ok: z.literal(true),
  keyId: z.uuid(),
  accountId: z.uuid(),
  permission: z.enum(['full', 'sending']),
  domainId: z.uuid().nullable(),
})

export type ApiKeyAuth = Omit<z.infer<typeof keyAccepted>, 'ok'>
export type KeyAnswer = { ok: true; key: ApiKeyAuth } | SqlRefusal

const queued = z.object({
  ok: z.literal(true),
  id: z.uuid(),
  status: z.enum(EMAIL_STATUSES),
  replayed: z.boolean(),
})

export type EnqueueAnswer = z.infer<typeof queued> | SqlRefusal

const timestamp = z.string().nullable()

/** GET /emails/{id}: status, timestamps and the last event — never a body (MR3). */
export const emailViewSchema = z.object({
  id: z.uuid(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  reply_to: z.array(z.string()),
  subject: z.string(),
  tags: z.array(z.object({ name: z.string(), value: z.string() })),
  status: z.enum(EMAIL_STATUSES),
  status_reason: z.string().nullable(),
  created_at: z.string(),
  scheduled_at: z.string(),
  sent_at: timestamp,
  delivered_at: timestamp,
  bounced_at: timestamp,
  complained_at: timestamp,
  failed_at: timestamp,
  last_event: z.string().nullable(),
  last_event_at: timestamp,
})

export type EmailView = z.infer<typeof emailViewSchema>

export type ApiStore = {
  authenticateKey(keyHash: string): Promise<KeyAnswer>
  enqueueEmail(input: {
    accountId: string
    keyId: string
    email: EnqueueInput
    idempotencyKey: string | null
    requestHash: string | null
  }): Promise<EnqueueAnswer>
  getEmail(accountId: string, emailId: string): Promise<EmailView | null>
}

function parseAnswer<T>(operation: string, accepted: z.ZodType<T>, data: unknown): T | SqlRefusal {
  const ok = accepted.safeParse(data)
  if (ok.success) return ok.data
  const refused = sqlRefusalSchema.safeParse(data)
  if (refused.success) return refused.data
  throw new StoreError(operation, 'unexpected_answer')
}

export function createApiStore(client: MailServiceClient): ApiStore {
  return {
    async authenticateKey(keyHash) {
      const { data, error } = await client.rpc('authenticate_key', { p_key_hash: keyHash })
      if (error) throw new StoreError('authenticate_key', error.code ?? null)
      const answer = parseAnswer('authenticate_key', keyAccepted, data)
      if (!answer.ok) return answer
      const { ok: _ok, ...key } = answer
      return { ok: true, key }
    },

    async enqueueEmail({ accountId, keyId, email, idempotencyKey, requestHash }) {
      const { data, error } = await client.rpc('enqueue_email', {
        p_account_id: accountId,
        p_api_key_id: keyId,
        p_email: email.email,
        p_payload: email.payload,
        ...(idempotencyKey && requestHash
          ? { p_idempotency_key: idempotencyKey, p_request_hash: requestHash }
          : {}),
      })
      if (error) throw new StoreError('enqueue_email', error.code ?? null)
      return parseAnswer('enqueue_email', queued, data)
    },

    async getEmail(accountId, emailId) {
      const { data, error } = await client.rpc('get_email', {
        p_account_id: accountId,
        p_public_id: emailId,
      })
      if (error) throw new StoreError('get_email', error.code ?? null)
      if (data === null) return null
      const view = emailViewSchema.safeParse(data)
      if (!view.success) throw new StoreError('get_email', 'unexpected_answer')
      return view.data
    },
  }
}
