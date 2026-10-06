import 'server-only'

import type { Json } from '@dr/db'
import {
  API_KEY_PERMISSIONS,
  type Cursor,
  EMAIL_STATUSES,
  type EmailRow,
  type EnqueueInput,
  emailRowSchema,
  type SqlRefusal,
  sqlRefusalSchema,
} from '@dr/shared/mail'
import { z } from 'zod'
import type { MailServiceClient } from '@/lib/supabase/service'

/**
 * The v1 API's database boundary: Mail's SQL functions (migrations 44 and
 * 48), called with the secret key, whose answers are parsed here — a shape
 * we did not expect is an error, never a guess. Every rule (key, gate, caps,
 * idempotency, which account may read or change what) is in SQL.
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
  permission: z.enum(API_KEY_PERMISSIONS),
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

const batchQueued = z.object({
  ok: z.literal(true),
  ids: z.array(z.uuid()).min(1),
  replayed: z.boolean(),
})
export type BatchAnswer = z.infer<typeof batchQueued> | SqlRefusal

const page = z.object({
  ok: z.literal(true),
  data: z.array(emailRowSchema),
  hasMore: z.boolean(),
  next: z.object({ at: z.string(), id: z.uuid() }).nullable(),
})
export type PageAnswer = z.infer<typeof page> | SqlRefusal

const changed = z.object({
  ok: z.literal(true),
  id: z.uuid(),
  status: z.enum(EMAIL_STATUSES),
  scheduledAt: z.string(),
})
export type ChangeAnswer = z.infer<typeof changed> | SqlRefusal

const keyRow = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  permission: z.enum(API_KEY_PERMISSIONS),
  domainId: z.uuid().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
})
export type KeyRow = z.infer<typeof keyRow>

const keyList = z.object({ ok: z.literal(true), keys: z.array(keyRow) })
const keyCreated = z.object({ ok: z.literal(true), key: keyRow })
export type KeyCreatedAnswer = z.infer<typeof keyCreated> | SqlRefusal
const keyRevoked = z.object({ ok: z.literal(true), keyId: z.uuid() })
export type KeyRevokedAnswer = z.infer<typeof keyRevoked> | SqlRefusal

export type ApiStore = {
  authenticateKey(keyHash: string): Promise<KeyAnswer>
  enqueueEmail(input: {
    accountId: string
    keyId: string
    email: EnqueueInput
    idempotencyKey: string | null
    requestHash: string | null
  }): Promise<EnqueueAnswer>
  enqueueBatch(input: {
    accountId: string
    keyId: string
    emails: EnqueueInput[]
    idempotencyKey: string | null
    requestHash: string | null
  }): Promise<BatchAnswer>
  getEmail(accountId: string, emailId: string): Promise<EmailRow | null>
  listEmails(input: {
    accountId: string
    filters: Record<string, string>
    cursor: Cursor | null
    limit: number
  }): Promise<PageAnswer>
  rescheduleEmail(accountId: string, emailId: string, at: string): Promise<ChangeAnswer>
  cancelEmail(accountId: string, emailId: string): Promise<ChangeAnswer>
  listKeys(accountId: string): Promise<KeyRow[]>
  createKey(input: {
    accountId: string
    actorKeyId: string
    name: string
    permission: (typeof API_KEY_PERMISSIONS)[number]
    prefix: string
    keyHash: string
    domainId: string | null
  }): Promise<KeyCreatedAnswer>
  revokeKey(accountId: string, actorKeyId: string, keyId: string): Promise<KeyRevokedAnswer>
}

function parseAnswer<T>(operation: string, accepted: z.ZodType<T>, data: unknown): T | SqlRefusal {
  const ok = accepted.safeParse(data)
  if (ok.success) return ok.data
  const refused = sqlRefusalSchema.safeParse(data)
  if (refused.success) return refused.data
  throw new StoreError(operation, 'unexpected_answer')
}

/**
 * Migration 48's functions, called before the generated types know them.
 * After applying 48 and regenerating (`--schema public,mail`), these become
 * plain `client.rpc` calls.
 */
type Untyped = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: Json | null; error: { code?: string } | null }>

export function createApiStore(client: MailServiceClient): ApiStore {
  const call48 = (fn: string, args: Record<string, unknown>) =>
    (client.rpc as unknown as Untyped)(fn, args)

  async function run<T>(fn: string, args: Record<string, unknown>, accepted: z.ZodType<T>) {
    const { data, error } = await call48(fn, args)
    if (error) throw new StoreError(fn, error.code ?? null)
    return parseAnswer(fn, accepted, data)
  }

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

    enqueueBatch({ accountId, keyId, emails, idempotencyKey, requestHash }) {
      return run(
        'enqueue_batch',
        {
          p_account_id: accountId,
          p_api_key_id: keyId,
          p_emails: emails.map(({ email, payload }) => ({ email, payload })),
          ...(idempotencyKey && requestHash
            ? { p_idempotency_key: idempotencyKey, p_request_hash: requestHash }
            : {}),
        },
        batchQueued,
      )
    },

    async getEmail(accountId, emailId) {
      const { data, error } = await client.rpc('get_email', {
        p_account_id: accountId,
        p_public_id: emailId,
      })
      if (error) throw new StoreError('get_email', error.code ?? null)
      if (data === null) return null
      const view = emailRowSchema.safeParse(data)
      if (!view.success) throw new StoreError('get_email', 'unexpected_answer')
      return view.data
    },

    listEmails({ accountId, filters, cursor, limit }) {
      return run(
        'list_emails',
        {
          p_account_id: accountId,
          p_filters: filters,
          p_limit: limit,
          ...(cursor ? { p_cursor_at: cursor.at, p_cursor_id: cursor.id } : {}),
        },
        page,
      )
    },

    rescheduleEmail(accountId, emailId, at) {
      return run(
        'reschedule_email',
        { p_account_id: accountId, p_public_id: emailId, p_scheduled_at: at },
        changed,
      )
    },

    cancelEmail(accountId, emailId) {
      return run('cancel_email', { p_account_id: accountId, p_public_id: emailId }, changed)
    },

    async listKeys(accountId) {
      const answer = await run('api_list_keys', { p_account_id: accountId }, keyList)
      if (!answer.ok) throw new StoreError('api_list_keys', answer.code)
      return answer.keys
    },

    createKey({ accountId, actorKeyId, name, permission, prefix, keyHash, domainId }) {
      return run(
        'api_create_key',
        {
          p_account_id: accountId,
          p_actor_key_id: actorKeyId,
          p_name: name,
          p_permission: permission,
          p_prefix: prefix,
          p_key_hash: keyHash,
          ...(domainId ? { p_domain_id: domainId } : {}),
        },
        keyCreated,
      )
    },

    revokeKey(accountId, actorKeyId, keyId) {
      return run(
        'api_revoke_key',
        { p_account_id: accountId, p_actor_key_id: actorKeyId, p_key_id: keyId },
        keyRevoked,
      )
    },
  }
}
