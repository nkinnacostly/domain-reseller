import 'server-only'

import { z } from 'zod'
import type { MailServiceClient } from '@/lib/supabase/service'

/**
 * /api/v1/domains' database boundary (migration 47): the key-checked
 * functions — SQL asks again that the key is live, full-access and the
 * account's — whose answers are parsed here. A shape we did not expect is an
 * error, never a guess.
 */

export class DomainApiStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`domains api store: ${operation} failed${code ? ` (${code})` : ''}`)
    this.name = 'DomainApiStoreError'
  }
}

export const domainViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(['pending', 'verified', 'failed', 'removing']),
  dkimTokens: z.array(z.string()),
  dkimStatus: z.string().nullable(),
  mailFromDomain: z.string().nullable(),
  mailFromStatus: z.string().nullable(),
  failedReason: z.string().nullable(),
  missingRecord: z.string().nullable(),
  settingUp: z.boolean(),
  createdAt: z.string(),
  claimedAt: z.string(),
  deadline: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
})

export type DomainView = z.infer<typeof domainViewSchema>

const refusal = z.looseObject({ ok: z.literal(false), code: z.string() })
export type DomainRefusal = z.infer<typeof refusal>

const listed = z.object({ ok: z.literal(true), domains: z.array(domainViewSchema) })
const one = z.object({ ok: z.literal(true), domain: domainViewSchema })
const added = z.object({ ok: z.literal(true), domainId: z.uuid(), name: z.string() })
const removed = z.looseObject({
  ok: z.literal(true),
  domainId: z.uuid(),
  needsRelease: z.boolean(),
})

export function createDomainApiStore(db: MailServiceClient) {
  async function answer<T extends z.ZodType>(
    operation: string,
    run: PromiseLike<{ data: unknown; error: unknown }>,
    accepted: T,
  ): Promise<z.infer<T> | DomainRefusal> {
    const { data, error } = await run
    if (error) throw new DomainApiStoreError(operation, (error as { code?: string }).code ?? null)
    const ok = accepted.safeParse(data)
    if (ok.success) return ok.data
    const no = refusal.safeParse(data)
    if (no.success) return no.data
    throw new DomainApiStoreError(operation, 'unexpected_answer')
  }

  return {
    list: (accountId: string, keyId: string) =>
      answer(
        'api_list_domains',
        db.rpc('api_list_domains', { p_account_id: accountId, p_actor_key_id: keyId }),
        listed,
      ),
    get: (accountId: string, keyId: string, domainId: string) =>
      answer(
        'api_get_domain',
        db.rpc('api_get_domain', {
          p_account_id: accountId,
          p_actor_key_id: keyId,
          p_domain_id: domainId,
        }),
        one,
      ),
    add: (accountId: string, keyId: string, name: string) =>
      answer(
        'api_add_domain',
        db.rpc('api_add_domain', { p_account_id: accountId, p_actor_key_id: keyId, p_name: name }),
        added,
      ),
    remove: (accountId: string, keyId: string, domainId: string) =>
      answer(
        'api_remove_domain',
        db.rpc('api_remove_domain', {
          p_account_id: accountId,
          p_actor_key_id: keyId,
          p_domain_id: domainId,
        }),
        removed,
      ),
  }
}

export type DomainApiStore = ReturnType<typeof createDomainApiStore>
