'use server'

import { newWebhookSecret, sealWebhookSecret, webhookSecretHint } from '@dr/shared/webhooks'
import { revalidatePath } from 'next/cache'
import { accountAction } from '@/lib/safe-action'
import { NO_SEAL_KEY, webhookKey } from '../lib/seal-key'
import { webhookRefusal } from '../lib/words'
import {
  createWebhookSchema,
  resendSchema,
  setEnabledSchema,
  updateWebhookSchema,
  webhookIdSchema,
} from '../schemas'

/**
 * Endpoints and deliveries (MAIL-SPEC §6, §10; migration 49). Owners,
 * admins and developers; SQL checks the role again on every call. A signing
 * secret is made here, sealed with MAIL_WEBHOOK_SECRET_KEY before it leaves
 * this server, and answered once to the person who asked — never stored
 * plain, never logged (MR6, N13). Every change names the account it is
 * made in — the one the role was checked for, and the one a new secret is
 * sealed for — and SQL refuses an endpoint of any other (migration 54).
 */

const MANAGERS = ['owner', 'admin', 'developer'] as const
const PAGE = '/dashboard/webhooks'

type Failure = { error: string }
type Done = { ok: true }

function refused(data: unknown): Failure | null {
  const answer = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  return answer?.ok === true ? null : { error: webhookRefusal(answer ?? {}) }
}

async function sealedSecret(accountId: string) {
  const key = webhookKey()
  if (!key) return null
  const secret = newWebhookSecret()
  return {
    secret,
    sealed: await sealWebhookSecret(key, secret, accountId),
    hint: webhookSecretHint(secret),
  }
}

export const createWebhook = accountAction(createWebhookSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { secret: string; webhookId: string }> => {
    const made = await sealedSecret(ctx.account.id)
    if (!made) return { error: NO_SEAL_KEY }
    const { data, error } = await ctx.supabase.rpc('create_webhook', {
      p_account_id: ctx.account.id,
      p_url: parsedInput.url,
      p_events: parsedInput.events,
      p_secret_sealed: made.sealed,
      p_secret_hint: made.hint,
      ...(parsedInput.description ? { p_description: parsedInput.description } : {}),
    })
    if (error) throw new Error(`create_webhook failed: ${error.code ?? 'unknown'}`)
    const refusal = refused(data)
    if (refusal) return refusal
    revalidatePath(PAGE)
    return { secret: made.secret, webhookId: String((data as { webhookId: string }).webhookId) }
  },
)

export const updateWebhook = accountAction(updateWebhookSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('update_webhook', {
      p_account_id: ctx.account.id,
      p_webhook_id: parsedInput.webhookId,
      p_url: parsedInput.url,
      p_events: parsedInput.events,
      ...(parsedInput.description ? { p_description: parsedInput.description } : {}),
    })
    if (error) throw new Error(`update_webhook failed: ${error.code ?? 'unknown'}`)
    const refusal = refused(data)
    if (refusal) return refusal
    revalidatePath(PAGE)
    return { ok: true }
  },
)

export const setWebhookEnabled = accountAction(setEnabledSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('set_webhook_enabled', {
      p_account_id: ctx.account.id,
      p_webhook_id: parsedInput.webhookId,
      p_enabled: parsedInput.enabled,
    })
    if (error) throw new Error(`set_webhook_enabled failed: ${error.code ?? 'unknown'}`)
    const refusal = refused(data)
    if (refusal) return refusal
    revalidatePath(PAGE)
    return { ok: true }
  },
)

export const rotateWebhookSecret = accountAction(webhookIdSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { secret: string }> => {
    const made = await sealedSecret(ctx.account.id)
    if (!made) return { error: NO_SEAL_KEY }
    const { data, error } = await ctx.supabase.rpc('rotate_webhook_secret', {
      p_account_id: ctx.account.id,
      p_webhook_id: parsedInput.webhookId,
      p_secret_sealed: made.sealed,
      p_secret_hint: made.hint,
    })
    if (error) throw new Error(`rotate_webhook_secret failed: ${error.code ?? 'unknown'}`)
    const refusal = refused(data)
    if (refusal) return refusal
    revalidatePath(PAGE)
    return { secret: made.secret }
  },
)

export const deleteWebhook = accountAction(webhookIdSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('delete_webhook', {
      p_account_id: ctx.account.id,
      p_webhook_id: parsedInput.webhookId,
    })
    if (error) throw new Error(`delete_webhook failed: ${error.code ?? 'unknown'}`)
    const refusal = refused(data)
    if (refusal) return refusal
    revalidatePath(PAGE)
    return { ok: true }
  },
)

export const resendDelivery = accountAction(resendSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | Done> => {
    const { data, error } = await ctx.supabase.rpc('resend_webhook_delivery', {
      p_account_id: ctx.account.id,
      p_delivery_id: parsedInput.deliveryId,
    })
    if (error) throw new Error(`resend_webhook_delivery failed: ${error.code ?? 'unknown'}`)
    const refusal = refused(data)
    if (refusal) return refusal
    revalidatePath(PAGE)
    return { ok: true }
  },
)
