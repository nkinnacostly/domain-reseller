import 'server-only'

import { type DelegationStatus, isRegistryHold, type LocalStatus } from '@dr/shared'
import { cacheLife, cacheTag } from 'next/cache'
import { cache } from 'react'
import { logger } from '@/lib/logger'
import { createPublicClient } from '@/lib/supabase/public'
import { createClient } from '@/lib/supabase/server'
import { sortLabels, toLabel } from '../lib/labels'
import { attributeHistory, type HistoryEntry } from '../lib/nameserver-history'
import type { PortfolioDomain } from '../lib/portfolio'
import type { RegistrarSide } from '../lib/registrar-default'

/** Domains are read as the user — RLS returns only their own (migration 12). */

// FR-P3: a domain's labels come through the link table. RLS shows only
// links to the account's own labels (migration 32).
const COLUMNS =
  'id, domain_name, tld, source, test_mode, local_status, expires_at, registered_at, auto_renew, privacy_enabled, transfer_lock, delegation_status, nameservers, pending_nameservers, nameserver_preset_id, registrant, registry_status, created_at, domain_label_links(domain_labels(id, name, color))'

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
  transfer_lock: boolean
  delegation_status: string
  nameservers: string[] | null
  pending_nameservers: string[] | null
  registry_status?: string | null
  domain_label_links?: { domain_labels: { id: string; name: string; color: string } | null }[]
}

/** Statuses in which we still hold the name at the registry, so a hold there is ours to show. */
const HELD_AT_REGISTRY: ReadonlySet<string> = new Set([
  'active',
  'expired_grace',
  'redemption',
  'pending_delete',
  'pending_verification',
])

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
    transferLock: row.transfer_lock,
    delegationStatus: row.delegation_status as DelegationStatus,
    nameservers: row.nameservers,
    pendingNameservers: row.pending_nameservers,
    onHold: HELD_AT_REGISTRY.has(row.local_status) && isRegistryHold(row.registry_status),
    labels: sortLabels(
      (row.domain_label_links ?? []).flatMap((link) =>
        link.domain_labels ? [toLabel(link.domain_labels)] : [],
      ),
    ),
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
    .select(`${COLUMNS}, previous_nameservers, order_items(failure_code, renewal_kobo)`)
    .eq('domain_name', decodeURIComponent(domainName).toLowerCase())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return {
    ...toPortfolio(data),
    registeredAt: data.registered_at as string | null,
    presetId: data.nameserver_preset_id as string | null,
    /** FR-N5 — the set a revert goes back to, kept by a trigger (migration 32). */
    previousNameservers: data.previous_nameservers as string[] | null,
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

type PresetRow = {
  id: string
  provider: string
  nameservers: string[]
  assigns_per_zone: boolean
  notes: string | null
  source_url: string
}

function toPreset(row: PresetRow): NameserverPreset {
  return {
    id: row.id,
    provider: row.provider,
    nameservers: row.nameservers,
    assignsPerZone: row.assigns_per_zone,
    notes: row.notes,
    sourceUrl: row.source_url,
  }
}

/**
 * FR-D2 — the hosts customers pick from: verified presets only (RLS hides the
 * rest), and never the registrar's own default (migration 35), which is not a
 * host. Same for everyone, so cached.
 *
 * The defaults are left out here rather than in the query so the list keeps
 * working on a database without that column yet: a web deploy ahead of the
 * migration must not empty every host picker.
 */
export async function getNameserverPresets(): Promise<NameserverPreset[]> {
  'use cache'
  cacheTag('nameserver-presets')
  cacheLife('hours')
  const { data } = await createPublicClient()
    .from('nameserver_presets')
    .select('*')
    .order('provider')
  return (data ?? []).filter((row) => !row.registrar_default_for).map(toPreset)
}

/**
 * The registrar's default nameservers on one side (migration 35) — what "Use
 * default DNS" fills in. Null when there is none to offer or it could not be
 * read: the form then leaves the button out rather than failing the page.
 */
export async function getRegistrarDefault(side: RegistrarSide): Promise<NameserverPreset | null> {
  try {
    return await loadRegistrarDefault(side)
  } catch (err) {
    logger.warn(
      { side, err: err instanceof Error ? err.message : String(err) },
      'registrar default nameservers unavailable',
    )
    return null
  }
}

/** The cached read. Throws on a failed query, so a failure is never cached as "none". */
export async function loadRegistrarDefault(side: RegistrarSide): Promise<NameserverPreset | null> {
  'use cache'
  cacheTag('nameserver-presets')
  cacheLife('hours')
  const { data, error } = await createPublicClient()
    .from('nameserver_presets')
    .select('id, provider, nameservers, assigns_per_zone, notes, source_url')
    .eq('registrar_default_for', side)
    .maybeSingle()
  if (error) throw new Error(`nameserver_presets: ${error.message}`)
  // Migration 35 holds a default to a fixed set; anything else has nothing to fill in.
  return data && !data.assigns_per_zone && data.nameservers.length > 0 ? toPreset(data) : null
}

/** Events that say where a nameserver change came from (FR-N5). */
const NAMESERVER_EVENTS = ['nameservers_requested', 'nameservers_synced']

/**
 * FR-N5 — the domain's nameserver changes, newest first, each with who
 * asked where the activity log says. Read as the user (RLS: owner only).
 * Null when the history could not be read, so the page can say so.
 */
export async function getNameserverHistory(domainId: string): Promise<HistoryEntry[] | null> {
  const supabase = await createClient()
  const [history, events] = await Promise.all([
    supabase
      .from('domain_nameserver_history')
      .select('before, after, changed_at')
      .eq('domain_id', domainId)
      .order('changed_at', { ascending: false })
      .limit(20),
    supabase
      .from('domain_events')
      .select('event_type, actor_type, payload, created_at')
      .eq('domain_id', domainId)
      .in('event_type', NAMESERVER_EVENTS)
      .order('created_at', { ascending: false })
      .limit(100),
  ])
  if (history.error) return null
  return attributeHistory(
    (history.data ?? []).map((row) => ({
      before: row.before,
      after: row.after,
      changedAt: row.changed_at,
    })),
    (events.data ?? []).map((event) => ({
      type: event.event_type,
      actorType: event.actor_type,
      payload: (event.payload ?? {}) as Record<string, unknown>,
      createdAt: event.created_at,
    })),
  )
}
