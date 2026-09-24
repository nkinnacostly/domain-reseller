import 'server-only'

import type { Contact } from '@dr/shared'
import { registrantFormSchema, toContact } from '@/features/checkout/lib/contact'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import {
  type ContactProfile,
  PROFILE_COLUMNS,
  type ProfileRow,
  profileFromRow,
} from '../lib/profiles'
import {
  CONTACT_ROLES,
  type ContactRole,
  heldByOthers,
  type ParsedRoleChoice,
  ROLE_LABEL,
} from '../lib/roles'

/** The signed-in person's client (RLS): every row here is their own. */
type Client = Awaited<ReturnType<typeof createClient>>

/**
 * The account's saved contacts, default first, then by name. Null when they
 * could not be read — the profiles page says so; pickers just offer none.
 */
export async function listContactProfiles(): Promise<ContactProfile[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('contact_profiles')
    .select(PROFILE_COLUMNS)
    .order('is_default', { ascending: false })
    .order('label')
    .limit(100)
  if (error) {
    logger.warn({ code: error.code, err: error.message }, 'contact profiles not read')
    return null
  }
  return (data as ProfileRow[]).map(profileFromRow)
}

type Resolved = { ok: true; contact: Contact | null } | { ok: false; error: string }

const PHONE = 'Check the phone number: it should be 4 to 15 digits after the code.'

/**
 * One role's contact from what the form chose: null for the registrant. A
 * saved profile is read again here, as the user (RLS), so the browser never
 * decides what a profile holds or reaches someone else's (FR-A4).
 */
export async function resolveRoleChoice(
  supabase: Client,
  choice: ParsedRoleChoice,
): Promise<Resolved> {
  if (choice.kind === 'registrant') return { ok: true, contact: null }
  if (choice.kind === 'new') {
    try {
      return { ok: true, contact: toContact(choice.contact) }
    } catch {
      return { ok: false, error: PHONE }
    }
  }

  const { data, error } = await supabase
    .from('contact_profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', choice.profileId)
    .maybeSingle()
  if (error) {
    // PostgREST's details can quote the row: the code and message only (N13).
    logger.warn({ code: error.code, err: error.message }, 'contact profile not read')
    return { ok: false, error: 'We couldn’t read your saved contacts just now. Try again.' }
  }
  if (!data) {
    return {
      ok: false,
      error:
        'That saved contact is no longer on your account. Choose another, or enter new details.',
    }
  }
  // Saved before a rule tightened, or written by checkout: checked like new details.
  const profile = profileFromRow(data as ProfileRow)
  const parsed = registrantFormSchema.safeParse(profile.values)
  const contact = parsed.success ? contactOrNull(parsed.data) : null
  if (!contact) {
    return {
      ok: false,
      error: `The saved contact “${profile.label}” is missing details. Complete it in Settings → Contacts, or enter new details.`,
    }
  }
  return { ok: true, contact }
}

function contactOrNull(form: Parameters<typeof toContact>[0]): Contact | null {
  try {
    return toContact(form)
  } catch {
    return null
  }
}

export type ResolvedRoles =
  | { ok: true; contacts: Partial<Record<ContactRole, Contact>> }
  | { ok: false; role: ContactRole; error: string }

/**
 * Checkout's other three contacts (FR-C5, FR-A4), validated on the server.
 * Roles the registrant holds are left out (migration 29) — including one
 * whose chosen details are the registrant's own.
 */
export async function resolveContactRoles(
  supabase: Client,
  input: Partial<Record<ContactRole, ParsedRoleChoice>> | undefined,
  registrant: Contact,
): Promise<ResolvedRoles> {
  const contacts: Partial<Record<ContactRole, Contact>> = {}
  for (const role of CONTACT_ROLES) {
    const choice = input?.[role]
    if (!choice) continue
    const resolved = await resolveRoleChoice(supabase, choice)
    if (!resolved.ok) {
      return { ok: false, role, error: `${ROLE_LABEL[role]} contact: ${resolved.error}` }
    }
    if (resolved.contact) contacts[role] = resolved.contact
  }
  return { ok: true, contacts: heldByOthers(contacts, registrant) }
}
