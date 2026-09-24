'use server'

import type { Contact } from '@dr/shared'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { toContact } from '@/features/checkout/lib/contact'
import { logger } from '@/lib/logger'
import { authAction } from '@/lib/safe-action'
import { MAX_PROFILES, profileFormSchema, rowFromContact } from '../lib/profiles'

/**
 * Saved contact profiles (FR-A4), written as the user: RLS keeps every read
 * and write to their own rows (migration 01). A profile is a copy source —
 * orders and domains keep their own snapshot, so editing or deleting one
 * never changes a domain. PostgREST's `details` can quote a row, so only a
 * code and message are logged (N13).
 */

export type ProfileResult = { ok: true } | { error: string }

const PAGE = '/app/settings/contacts'
const FAILED = 'That could not be saved. Please try again.'
const GONE = 'That contact is no longer on your account. Reload the page to see your contacts.'

const logged = (error: { code?: string; message: string }, what: string) => {
  logger.warn({ code: error.code, err: error.message }, what)
  return { error: FAILED }
}

/** Adds or edits a profile; ticking "default" takes it from any other (one per account). */
export const saveContactProfile = authAction
  .inputSchema(profileFormSchema)
  .action(async ({ parsedInput, ctx }): Promise<ProfileResult> => {
    const { supabase, user } = ctx
    let contact: Contact
    try {
      contact = toContact(parsedInput.contact)
    } catch {
      return { error: 'Check the phone number: it should be 4 to 15 digits after the code.' }
    }

    if (!parsedInput.id) {
      const { count, error } = await supabase
        .from('contact_profiles')
        .select('id', { count: 'exact', head: true })
      if (error) return logged(error, 'contact profiles not counted')
      if ((count ?? 0) >= MAX_PROFILES) {
        return {
          error: `You can save up to ${MAX_PROFILES} contacts. Delete one you no longer use, then add this one.`,
        }
      }
    }

    // One default per account (unique index, migration 01): clear it first.
    if (parsedInput.isDefault) {
      const cleared = await supabase
        .from('contact_profiles')
        .update({ is_default: false })
        .eq('user_id', user.id)
        .eq('is_default', true)
      if (cleared.error) return logged(cleared.error, 'default contact not cleared')
    }

    const row = {
      ...rowFromContact(contact),
      label: parsedInput.label,
      is_default: parsedInput.isDefault,
    }
    const saved = parsedInput.id
      ? await supabase
          .from('contact_profiles')
          .update(row)
          .eq('id', parsedInput.id)
          .select('id')
          .maybeSingle()
      : await supabase
          .from('contact_profiles')
          .insert({ ...row, user_id: user.id })
          .select('id')
          .single()
    if (saved.error) return logged(saved.error, 'contact profile not saved')
    revalidatePath(PAGE)
    return saved.data ? { ok: true } : { error: GONE }
  })

/** Makes one profile the one checkout fills the registrant in from. */
export const makeDefaultContactProfile = authAction
  .inputSchema(z.object({ id: z.uuid() }))
  .action(async ({ parsedInput, ctx }): Promise<ProfileResult> => {
    const { supabase, user } = ctx
    const { data: found, error } = await supabase
      .from('contact_profiles')
      .select('id')
      .eq('id', parsedInput.id)
      .maybeSingle()
    if (error) return logged(error, 'contact profile not read')
    if (!found) return { error: GONE }

    const cleared = await supabase
      .from('contact_profiles')
      .update({ is_default: false })
      .eq('user_id', user.id)
      .eq('is_default', true)
    if (cleared.error) return logged(cleared.error, 'default contact not cleared')
    const made = await supabase
      .from('contact_profiles')
      .update({ is_default: true })
      .eq('id', parsedInput.id)
    if (made.error) return logged(made.error, 'default contact not set')
    revalidatePath(PAGE)
    return { ok: true }
  })

/** Deletes a profile. Orders and domains that used it keep their own copy. */
export const deleteContactProfile = authAction
  .inputSchema(z.object({ id: z.uuid() }))
  .action(async ({ parsedInput, ctx }): Promise<ProfileResult> => {
    const { data, error } = await ctx.supabase
      .from('contact_profiles')
      .delete()
      .eq('id', parsedInput.id)
      .select('id')
    if (error) return logged(error, 'contact profile not deleted')
    revalidatePath(PAGE)
    return data && data.length > 0 ? { ok: true } : { error: GONE }
  })
