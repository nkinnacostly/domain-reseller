'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { parseNameservers } from '@/features/checkout/lib/nameservers'
import { logger } from '@/lib/logger'
import { authAction, elevatedAction } from '@/lib/safe-action'
import type { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { judgeNameservers, sameNameservers } from '../lib/nameserver-check'
import { lookupHost } from '../queries/dns'

/**
 * Domain changes. Ownership is checked as the user (RLS); the write is then
 * made with the secret key, because customers never write domain rows
 * directly (migration 12). Every change leaves a domain_events row.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>

/** The domain, if it is this user's — RLS answers that, not our code. */
async function ownedDomain(supabase: Supabase, domainId: string) {
  const { data } = await supabase
    .from('domains')
    .select('id, domain_name, source, local_status, nameservers, pending_nameservers')
    .eq('id', domainId)
    .maybeSingle()
  return data
}

const FAILED = 'That change could not be saved. Please try again.'

/** Auto-renew is our own billing preference (FR-RN2), so it is ours to store. */
export const setAutoRenew = authAction
  .inputSchema(z.object({ domainId: z.uuid(), autoRenew: z.boolean() }))
  .action(async ({ parsedInput, ctx }): Promise<{ error: string } | { ok: true }> => {
    const domain = await ownedDomain(ctx.supabase, parsedInput.domainId)
    if (!domain) return { error: 'That domain is not on your account.' }

    const service = createServiceClient()
    const { error } = await service
      .from('domains')
      .update({ auto_renew: parsedInput.autoRenew })
      .eq('id', domain.id)
    if (error) {
      logger.error({ err: error }, 'auto-renew update failed')
      return { error: FAILED }
    }
    await service.from('domain_events').insert({
      domain_id: domain.id,
      event_type: parsedInput.autoRenew ? 'auto_renew_on' : 'auto_renew_off',
      actor_type: 'user',
      actor_id: ctx.user.id,
    })
    revalidatePath(`/app/domains/${domain.domain_name}`)
    return { ok: true }
  })

/** What became of a saved nameserver change — the form says exactly this. */
export type NameserverDelivery = 'queued' | 'after_registration' | 'demo'

/**
 * A nameserver change (FR-D1, FR-D4, SEC-2). A sensitive operation: it needs
 * a second factor from the last 15 minutes and no post-reset hold
 * (elevatedAction). Validated against live DNS before it is accepted, then
 * recorded as the requested set and queued for the registry (FR-N1). A domain
 * still registering gets it straight after registration (FR-R5); a demo
 * domain never reaches a registry.
 */
export const requestNameservers = elevatedAction
  .inputSchema(
    z.object({
      domainId: z.uuid(),
      nameservers: z.string().max(2000),
      presetId: z.uuid().nullable().optional(),
    }),
  )
  .action(
    async ({
      parsedInput,
      ctx,
    }): Promise<
      | { error: string; details?: string[] }
      | { ok: true; warnings: string[]; delivery: NameserverDelivery; unchanged?: boolean }
    > => {
      const domain = await ownedDomain(ctx.supabase, parsedInput.domainId)
      if (!domain) return { error: 'That domain is not on your account.' }
      if (!['active', 'pending'].includes(domain.local_status)) {
        return { error: 'Nameservers can only be changed on an active domain.' }
      }

      const parsed = parseNameservers(parsedInput.nameservers)
      if (!parsed.ok) return { error: parsed.error }
      if (!parsed.nameservers) return { error: 'Enter at least two nameservers.' }
      const next = parsed.nameservers
      const service = createServiceClient()
      const delivery: NameserverDelivery =
        domain.source === 'demo'
          ? 'demo'
          : domain.local_status === 'pending'
            ? 'after_registration'
            : 'queued'

      /** Idempotent: a change already open is left to finish (migration 13). */
      const sendToRegistry = async () => {
        if (delivery !== 'queued') return true
        const { error } = await service.rpc('enqueue_nameserver_change', { p_domain_id: domain.id })
        if (error) logger.error({ err: error }, 'nameserver change not queued')
        return !error
      }

      if (sameNameservers(next, domain.pending_nameservers ?? domain.nameservers)) {
        // Asking again re-queues a change whose earlier queueing failed.
        if (domain.pending_nameservers && !(await sendToRegistry())) return { error: FAILED }
        return { ok: true, warnings: [], delivery, unchanged: true }
      }

      const lookups = new Map(
        await Promise.all(next.map(async (host) => [host, await lookupHost(host)] as const)),
      )
      const verdict = judgeNameservers(domain.domain_name, lookups)
      if (verdict.blocking.length > 0) {
        return {
          error: 'Some nameservers need fixing before we can use them.',
          details: verdict.blocking,
        }
      }

      // N11: the host label is kept only for a preset customers can see — never
      // a hidden or unverified one the browser sent.
      const presetId = parsedInput.presetId
        ? await visiblePresetId(service, parsedInput.presetId)
        : null
      const { error } = await service
        .from('domains')
        .update({ pending_nameservers: next, nameserver_preset_id: presetId })
        .eq('id', domain.id)
      if (error) {
        logger.error({ err: error }, 'nameserver request failed')
        return { error: FAILED }
      }
      // FR-N5 — before and after, with who asked.
      await service.from('domain_events').insert({
        domain_id: domain.id,
        event_type: 'nameservers_requested',
        actor_type: 'user',
        actor_id: ctx.user.id,
        payload: { before: domain.pending_nameservers ?? domain.nameservers, after: next },
      })
      const queued = await sendToRegistry()
      revalidatePath(`/app/domains/${domain.domain_name}`, 'layout')
      if (!queued) return { error: FAILED }
      return { ok: true, warnings: verdict.warnings, delivery }
    },
  )

async function visiblePresetId(
  service: ReturnType<typeof createServiceClient>,
  presetId: string,
): Promise<string | null> {
  const { data } = await service
    .from('nameserver_presets')
    .select('id, is_hidden, verified_at')
    .eq('id', presetId)
    .maybeSingle()
  return data && !data.is_hidden && data.verified_at ? data.id : null
}
