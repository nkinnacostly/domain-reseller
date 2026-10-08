import type { Database, Json } from '@dr/db'
import {
  type ApiKeyAuth,
  type EnqueueInput,
  type SqlRefusal,
  sqlEnqueuedSchema,
  sqlKeyAcceptedSchema,
  sqlRefusalSchema,
} from '@dr/shared/mail'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'

/**
 * The relay's database boundary: the same two SQL functions the v1 API
 * calls (authenticate_key, enqueue_email), with the secret key, and the
 * shop's heartbeat. Every rule — the key, the gate, the caps, suppression,
 * the sandbox, idempotency — is in SQL; this parses the answers, and a shape
 * it did not expect is an error, never a guess.
 */

export type MailClient = SupabaseClient<Database, 'mail'>

export class StoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`smtp store: ${operation} failed${code ? ` (${code})` : ''}`)
    this.name = 'StoreError'
  }
}

export type KeyAnswer = { ok: true; key: ApiKeyAuth } | SqlRefusal
export type EnqueueAnswer = z.infer<typeof sqlEnqueuedSchema> | SqlRefusal

export type RelayStore = {
  authenticateKey(keyHash: string): Promise<KeyAnswer>
  enqueueEmail(input: {
    accountId: string
    keyId: string
    email: EnqueueInput
    idempotencyKey: string | null
    requestHash: string | null
  }): Promise<EnqueueAnswer>
  heartbeat(name: string, detail: { [key: string]: Json }): Promise<void>
}

function answered<T>(
  operation: string,
  accepted: z.ZodType<T>,
  { data, error }: { data: unknown; error: { code?: string } | null },
): T | SqlRefusal {
  if (error) throw new StoreError(operation, error.code ?? null)
  const ok = accepted.safeParse(data)
  if (ok.success) return ok.data
  const refused = sqlRefusalSchema.safeParse(data)
  if (refused.success) return refused.data
  throw new StoreError(operation, 'unexpected_answer')
}

export function createRelayStore(client: MailClient): RelayStore {
  return {
    async authenticateKey(keyHash) {
      const answer = answered(
        'authenticate_key',
        sqlKeyAcceptedSchema,
        await client.rpc('authenticate_key', { p_key_hash: keyHash }),
      )
      if (!answer.ok) return answer
      const { ok: _ok, ...key } = answer
      return { ok: true, key }
    },

    async enqueueEmail({ accountId, keyId, email, idempotencyKey, requestHash }) {
      return answered(
        'enqueue_email',
        sqlEnqueuedSchema,
        await client.rpc('enqueue_email', {
          p_account_id: accountId,
          p_api_key_id: keyId,
          p_email: email.email as unknown as Json,
          p_payload: email.payload as unknown as Json,
          ...(idempotencyKey && requestHash
            ? { p_idempotency_key: idempotencyKey, p_request_hash: requestHash }
            : {}),
        }),
      )
    },

    async heartbeat(name, detail) {
      const { error } = await client
        .schema('public')
        .rpc('record_heartbeat', { p_name: name, p_test_mode: false, p_detail: detail })
      if (error) throw new StoreError('record_heartbeat', error.code ?? null)
    },
  }
}
