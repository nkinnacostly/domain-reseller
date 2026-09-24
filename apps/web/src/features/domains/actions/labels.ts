'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { authAction } from '@/lib/safe-action'
import type { createClient } from '@/lib/supabase/server'
import {
  type DomainLabel,
  labelColorSchema,
  labelNameSchema,
  labelWriteError,
  toLabel,
} from '../lib/labels'

/**
 * FR-P3 — the account's labels. Unlike registry settings these are ours
 * alone, and the customer's own to write: RLS lets an account insert,
 * update and delete its own labels, and link them to its own domains
 * (migration 32). So these run on the signed-in client — no secret key —
 * and the database, not this code, decides whose a label is.
 */

export type LabelResult = { error: string } | { ok: true; label: DomainLabel }
export type LinkResult = { error: string } | { ok: true }

const NOT_YOURS = 'That label is not on your account.'
const DOMAIN_NOT_YOURS = 'That domain is not on your account.'

function refreshLabels(domainName?: string) {
  revalidatePath('/app/domains')
  revalidatePath('/app/settings/labels')
  if (domainName) revalidatePath(`/app/domains/${domainName}`)
}

export const createLabel = authAction
  .inputSchema(
    z.object({
      name: labelNameSchema,
      color: labelColorSchema,
      /** Given from a domain's page: the new label goes straight onto it. */
      domainId: z.uuid().optional(),
    }),
  )
  .action(async ({ parsedInput, ctx }): Promise<LabelResult> => {
    // The domain first, so a label is never made for a domain it cannot go on.
    const domain = parsedInput.domainId
      ? await ownedDomain(ctx.supabase, parsedInput.domainId)
      : null
    if (parsedInput.domainId && !domain) return { error: DOMAIN_NOT_YOURS }

    const { data, error } = await ctx.supabase
      .from('domain_labels')
      .insert({ user_id: ctx.user.id, name: parsedInput.name, color: parsedInput.color })
      .select('id, name, color')
      .single()
    if (error || !data) {
      if (!['23505', '23514'].includes(error?.code ?? '')) {
        logger.error({ code: error?.code }, 'label not created')
      }
      return { error: labelWriteError(error, parsedInput.name) }
    }
    const label = toLabel(data)

    if (domain) {
      const linked = await link(ctx.supabase, domain.id, label.id)
      if ('error' in linked) return linked
    }
    refreshLabels(domain?.domain_name)
    return { ok: true, label }
  })

/** Rename or recolour — one form edits both. */
export const updateLabel = authAction
  .inputSchema(z.object({ id: z.uuid(), name: labelNameSchema, color: labelColorSchema }))
  .action(async ({ parsedInput, ctx }): Promise<LabelResult> => {
    const { data, error } = await ctx.supabase
      .from('domain_labels')
      .update({ name: parsedInput.name, color: parsedInput.color })
      .eq('id', parsedInput.id)
      .select('id, name, color')
      .maybeSingle()
    if (error) {
      if (error.code !== '23505') logger.error({ code: error.code }, 'label not updated')
      return { error: labelWriteError(error, parsedInput.name) }
    }
    // RLS hides another account's label, so nothing was updated.
    if (!data) return { error: NOT_YOURS }
    refreshLabels()
    return { ok: true, label: toLabel(data) }
  })

/** Deleting a label takes it off every domain (the links cascade); the domains stay. */
export const deleteLabel = authAction
  .inputSchema(z.object({ id: z.uuid() }))
  .action(async ({ parsedInput, ctx }): Promise<LinkResult> => {
    const { data, error } = await ctx.supabase
      .from('domain_labels')
      .delete()
      .eq('id', parsedInput.id)
      .select('id')
    if (error) {
      logger.error({ code: error.code }, 'label not deleted')
      return { error: 'That label could not be deleted. Please try again.' }
    }
    if (!data?.length) return { error: NOT_YOURS }
    refreshLabels()
    return { ok: true }
  })

type Supabase = Awaited<ReturnType<typeof createClient>>

/** The domain, if it is this account's — RLS answers that, not our code. */
async function ownedDomain(supabase: Supabase, domainId: string) {
  const { data } = await supabase
    .from('domains')
    .select('id, domain_name')
    .eq('id', domainId)
    .maybeSingle()
  return data
}

/** Links a label to a domain. Linking twice is not an error. */
async function link(supabase: Supabase, domainId: string, labelId: string): Promise<LinkResult> {
  const { error } = await supabase
    .from('domain_label_links')
    .insert({ label_id: labelId, domain_id: domainId })
  if (error && error.code !== '23505') {
    // 42501: RLS refused a label that is not the account's own.
    if (error.code === '42501') return { error: NOT_YOURS }
    logger.error({ code: error.code }, 'label not linked')
    return { error: 'That label could not be added. Please try again.' }
  }
  return { ok: true }
}

/** FR-P3 — put a label on one domain, or take it off. */
export const setDomainLabel = authAction
  .inputSchema(z.object({ domainId: z.uuid(), labelId: z.uuid(), on: z.boolean() }))
  .action(async ({ parsedInput, ctx }): Promise<LinkResult> => {
    const domain = await ownedDomain(ctx.supabase, parsedInput.domainId)
    if (!domain) return { error: DOMAIN_NOT_YOURS }

    if (parsedInput.on) {
      const linked = await link(ctx.supabase, domain.id, parsedInput.labelId)
      if ('error' in linked) return linked
    } else {
      const { error } = await ctx.supabase
        .from('domain_label_links')
        .delete()
        .eq('label_id', parsedInput.labelId)
        .eq('domain_id', domain.id)
      if (error) {
        logger.error({ code: error.code }, 'label not unlinked')
        return { error: 'That label could not be removed. Please try again.' }
      }
    }
    refreshLabels(domain.domain_name)
    return { ok: true }
  })
