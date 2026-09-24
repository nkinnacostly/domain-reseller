import 'server-only'

import { createClient } from '@/lib/supabase/server'

/**
 * What the Security and Contacts tabs need beyond the domain itself, read
 * as the user (RLS): the changes waiting for the registry (migration 26),
 * and when the domain last arrived by transfer, for the 60-day rule (FR-T7).
 */
export type DomainSettings = {
  pendingTransferLock: boolean | null
  pendingPrivacy: boolean | null
  pendingRegistrant: Record<string, string> | null
  transferredInAt: string | null
}

export async function getDomainSettings(domainId: string): Promise<DomainSettings> {
  const supabase = await createClient()
  const [{ data: domain }, { data: transfer }] = await Promise.all([
    supabase
      .from('domains')
      .select('pending_transfer_lock, pending_privacy, pending_registrant')
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
    transferredInAt: transfer?.created_at ?? null,
  }
}
