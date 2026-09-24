import 'server-only'

import type { DelegationStatus, LocalStatus } from '@dr/shared'
import { cacheLife, cacheTag } from 'next/cache'
import { cache } from 'react'
import { createPublicClient } from '@/lib/supabase/public'
import { createClient } from '@/lib/supabase/server'
import type { PortfolioDomain } from '../lib/portfolio'

/** Domains are read as the user — RLS returns only their own (migration 12). */

const COLUMNS =
  'id, domain_name, tld, source, test_mode, local_status, expires_at, registered_at, auto_renew, privacy_enabled, transfer_lock, delegation_status, nameservers, pending_nameservers, nameserver_preset_id, registrant, created_at'

type Row = {
  id: string
  domain_name: string
  tld: string
  source: string
  test_mode: boolean
  local_status: string
  expires_at: string | null
  auto_renew: boolean
  privacy_enabled: boolean
  delegation_status: string
  nameservers: string[] | null
  pending_nameservers: string[] | null
}

function toPortfolio(row: Row): PortfolioDomain {
  return {
    id: row.id,
    domainName: row.domain_name,
    tld: row.tld,
    source: row.source as PortfolioDomain['source'],
    testMode: row.test_mode,
    status: row.local_status as LocalStatus,
    expiresAt: row.expires_at,
    autoRenew: row.auto_renew,
    privacyEnabled: row.privacy_enabled,
    delegationStatus: row.delegation_status as DelegationStatus,
    nameservers: row.nameservers,
    pendingNameservers: row.pending_nameservers,
  }
}

/** Request-scoped: the panel's sidebar and the portfolio page share one read. */
export const getPortfolio = cache(async (): Promise<PortfolioDomain[]> => {
  const supabase = await createClient()
  const { data } = await supabase.from('domains').select(COLUMNS).order('domain_name').limit(500)
  return (data ?? []).map(toPortfolio)
})

export type RecentEvent = {
  id: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
  domainName: string
}

/** The latest events across the account's domains, newest first (FR-P6). */
export async function getRecentActivity(limit = 6): Promise<RecentEvent[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('domain_events')
    .select('id, event_type, payload, created_at, domains!inner(domain_name)')
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []).map((row) => ({
    id: Number(row.id),
    type: row.event_type,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
    domainName: row.domains.domain_name,
  }))
}

/** One domain by name — the URL segment. Null if it is not the user's. */
export const getDomain = cache(async (domainName: string) => {
  const supabase = await createClient()
  const { data } = await supabase
    .from('domains')
    .select(`${COLUMNS}, order_items(failure_code, renewal_kobo)`)
    .eq('domain_name', decodeURIComponent(domainName).toLowerCase())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return {
    ...toPortfolio(data),
    registeredAt: data.registered_at as string | null,
    transferLock: data.transfer_lock as boolean,
    presetId: data.nameserver_preset_id as string | null,
    registrant: data.registrant as Record<string, string> | null,
    /** Why registration failed, when it did (PRD §13.8 code). */
    failureCode: data.order_items?.failure_code ?? null,
    /** The renewal price quoted when it was bought (N8) — FR-RN7 compares with it. */
    promisedRenewalKobo:
      data.order_items?.renewal_kobo === undefined || data.order_items?.renewal_kobo === null
        ? null
        : Number(data.order_items.renewal_kobo),
  }
})
export type DomainDetail = NonNullable<Awaited<ReturnType<typeof getDomain>>>

export async function getDomainEvents(domainId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('domain_events')
    .select('id, event_type, actor_type, payload, created_at')
    .eq('domain_id', domainId)
    .order('created_at', { ascending: false })
    .limit(100)
  return data ?? []
}

export type NameserverPreset = {
  id: string
  provider: string
  nameservers: string[]
  assignsPerZone: boolean
  notes: string | null
  sourceUrl: string
}

/** FR-D2 — verified presets only (RLS hides the rest). Same for everyone, so cached. */
export async function getNameserverPresets(): Promise<NameserverPreset[]> {
  'use cache'
  cacheTag('nameserver-presets')
  cacheLife('hours')
  const { data } = await createPublicClient()
    .from('nameserver_presets')
    .select('id, provider, nameservers, assigns_per_zone, notes, source_url')
    .order('provider')
  return (data ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    nameservers: row.nameservers,
    assignsPerZone: row.assigns_per_zone,
    notes: row.notes,
    sourceUrl: row.source_url,
  }))
}
