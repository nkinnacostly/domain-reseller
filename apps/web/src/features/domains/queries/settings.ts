import 'server-only'

import { readRoles, type StoredRoles } from '@/features/contacts/lib/roles'
import { createClient } from '@/lib/supabase/server'

/**
 * What the Security and Contacts tabs need beyond the domain itself, read
 * as the user (RLS): the changes waiting for the registry (migration 26),
 * and when the domain last arrived by transfer, for the 60-day rule (FR-T7).
 * The other three contacts (FR-DS1, migration 29): a role left out is the
 * registrant's; `pendingContacts` is null when no change waits, `{}` when all
 * three are going back to the registrant.
 */
export type DomainSettings = {
  pendingTransferLock: boolean | null
  pendingPrivacy: boolean | null
  pendingRegistrant: Record<string, string> | null
  contacts: StoredRoles
  pendingContacts: StoredRoles | null
  transferredInAt: string | null
}

export async function getDomainSettings(domainId: string): Promise<DomainSettings> {
  const supabase = await createClient()
  const [{ data: domain }, { data: transfer }] = await Promise.all([
    supabase
      .from('domains')
      .select(
        'pending_transfer_lock, pending_privacy, pending_registrant, contacts, pending_contacts',
      )
      .eq('id', domainId)
      .maybeSingle(),
    supabase
      .from('domain_events')
      .select('created_at')
      .eq('domain_id', domainId)
      .eq('event_type', 'transferred_in')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  return {
    pendingTransferLock: domain?.pending_transfer_lock ?? null,
    pendingPrivacy: domain?.pending_privacy ?? null,
    pendingRegistrant: (domain?.pending_registrant as Record<string, string> | null) ?? null,
    contacts: readRoles(domain?.contacts),
    pendingContacts:
      domain?.pending_contacts === null || domain?.pending_contacts === undefined
        ? null
        : readRoles(domain.pending_contacts),
    transferredInAt: transfer?.created_at ?? null,
  }
}
