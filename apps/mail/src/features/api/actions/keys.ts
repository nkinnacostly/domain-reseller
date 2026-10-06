'use server'

import { type ApiKeyPermission, hashApiKey, newApiKey } from '@dr/shared/mail'
import { revalidatePath } from 'next/cache'
import { requireApiKeyPepper } from '@/lib/env'
import { accountAction } from '@/lib/safe-action'
import { keyRefusal, permissionsFor } from '../lib/keys'
import { createKeyInput, revokeKeyInput } from '../schemas/keys'

/**
 * API keys from the dashboard (MAIL-SPEC MR7, §10), as the signed-in member:
 * `create_api_key` and `revoke_api_key` (migration 43) decide who may do
 * what. A new key is made here, its hash — sha256(pepper ‖ key) — and prefix
 * go to SQL, and the key itself goes back to this person's browser once.
 * It is never stored, cached or logged (N13).
 */

type Failure = { error: string }
export type NewKey = { key: string; prefix: string; name: string; permission: ApiKeyPermission }

const PAGE = '/dashboard/api-keys'

const answerOf = (data: unknown) =>
  data && typeof data === 'object' && !Array.isArray(data)
    ? (data as { ok?: unknown; code?: unknown; field?: unknown })
    : null

export const createApiKey = accountAction(createKeyInput, ['owner', 'admin', 'developer']).action(
  async ({ parsedInput, ctx }): Promise<Failure | NewKey> => {
    if (!permissionsFor(ctx.account.role).includes(parsedInput.permission)) {
      return { error: keyRefusal({ code: 'forbidden' }) }
    }
    const { key, prefix } = newApiKey()
    const { data, error } = await ctx.supabase.rpc('create_api_key', {
      p_account_id: ctx.account.id,
      p_name: parsedInput.name,
      p_permission: parsedInput.permission,
      p_prefix: prefix,
      p_key_hash: await hashApiKey(key, requireApiKeyPepper()),
      ...(parsedInput.domainId ? { p_domain_id: parsedInput.domainId } : {}),
    })
    if (error) throw new Error(`create_api_key failed: ${error.code ?? 'unknown'}`)
    const answer = answerOf(data)
    if (answer?.ok !== true) return { error: keyRefusal(answer) }
    return { key, prefix, name: parsedInput.name, permission: parsedInput.permission }
  },
)

export const revokeApiKey = accountAction(revokeKeyInput, ['owner', 'admin', 'developer']).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    const { data, error } = await ctx.supabase.rpc('revoke_api_key', {
      p_key_id: parsedInput.keyId,
    })
    if (error) throw new Error(`revoke_api_key failed: ${error.code ?? 'unknown'}`)
    const answer = answerOf(data)
    if (answer?.ok !== true) return { error: keyRefusal(answer) }
    revalidatePath(PAGE)
    return { ok: true }
  },
)
