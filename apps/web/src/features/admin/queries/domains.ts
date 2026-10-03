import 'server-only'

import { z } from 'zod'
import { driftComparison } from '@/features/admin/lib/alerts-copy'
import { gatewayHeartbeat } from '@/features/admin/lib/domains-copy'
import {
  DOMAIN_SORT_COLUMN,
  type DomainListParams,
  expiryRange,
  watDayEnd,
  watDayStart,
} from '@/features/admin/lib/domains-params'
import { pageRange } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { type AdminDb, type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The domains pages' reads (docs/ADMIN-SPEC.md §5.2, B9). Rows come through
 * `adminDb`, which applies the Live/Test side itself; a domain through
 * `admin_domains_v`, which holds the registrant's country and type and never
 * the registrant or contacts (§3.2i) — those come only from the audited
 * `admin_reveal_registrant` (actions/domains.ts). Figures come from
 * `admin_domain_stats`. Logs carry codes only — never a domain or a search
 * (N13).
 */

export class DomainsReadError extends Error {
  constructor(readonly what: string) {
    super(`admin domains: could not read ${what}`)
    this.name = 'DomainsReadError'
  }
}

type Answer = { data: unknown; error: { code?: string; message: string } | null }
type Read<A extends Answer> = Extract<A, { error: null }>['data']

function read<A extends Answer>(what: string, answer: A): Read<A> {
  if (answer.error) {
    // The code only: a message can quote the value that was looked for (N13).
    logger.warn({ what, code: answer.error.code }, 'admin domains read failed')
    throw new DomainsReadError(what)
  }
  return answer.data as Read<A>
}

// ── The list ───────────────────────────────────────────────────────────────

export type DomainListRow = {
  id: string
  name: string
  tld: string | null
  source: string | null
  testMode: boolean
  userId: string | null
  status: string | null
  expiresAt: string | null
  autoRenew: boolean | null
  transferLock: boolean | null
  pendingTransferLock: boolean | null
  privacy: boolean | null
  pendingPrivacy: boolean | null
  delegation: string | null
  registryStatus: string | null
  registryCheckedAt: string | null
  createdAt: string | null
}

export type DomainList = { rows: DomainListRow[]; total: number }

/** One page of the side's domains, filtered and sorted in SQL by the URL's values. */
export async function listDomains(
  admin: AdminPrincipal,
  side: AdminSide,
  params: DomainListParams,
  now: Date,
): Promise<DomainList> {
  let query = adminDb(admin, side)
    .from('admin_domains_v')
    .select(
      'id, domain_name, tld, source, test_mode, user_id, local_status, expires_at, auto_renew, transfer_lock, pending_transfer_lock, privacy_enabled, pending_privacy, delegation_status, registry_status, registry_checked_at, created_at',
      { count: 'exact' },
    )
  if (params.status.length > 0) query = query.in('local_status', params.status)
  if (params.tld) query = query.eq('tld', params.tld)
  // Demo rows were never at a registry; the stats leave them out too.
  query = params.source ? query.eq('source', params.source) : query.neq('source', 'demo')
  if (params.delegation) query = query.eq('delegation_status', params.delegation)
  if (params.renew) query = query.eq('auto_renew', params.renew === 'on')
  if (params.expires) {
    const range = expiryRange(params.expires, now)
    if (range.before) query = query.lt('expires_at', range.before)
    if (range.from) query = query.gte('expires_at', range.from)
    if (range.to) query = query.lte('expires_at', range.to)
  }
  if (params.from) query = query.gte('created_at', watDayStart(params.from))
  if (params.to) query = query.lt('created_at', watDayEnd(params.to))
  // Letters, digits, dots and hyphens only (classifyDomainSearch): no LIKE syntax.
  if (params.search.kind === 'name') query = query.ilike('domain_name', `%${params.search.value}%`)

  const { from, to } = pageRange(params)
  const answer = await query
    .order(DOMAIN_SORT_COLUMN[params.sort], {
      ascending: params.dir === 'asc',
      nullsFirst: false,
    })
    .order('id', { ascending: true })
    .range(from, to)
  const rows = read('domains', answer) ?? []
  return {
    total: answer.count ?? rows.length,
    rows: rows
      .filter((row) => row.id && row.domain_name)
      .map(
        (row): DomainListRow => ({
          id: row.id as string,
          name: row.domain_name as string,
          tld: row.tld,
          source: row.source,
          testMode: row.test_mode === true,
          userId: row.user_id,
          status: row.local_status,
          expiresAt: row.expires_at,
          autoRenew: row.auto_renew,
          transferLock: row.transfer_lock,
          pendingTransferLock: row.pending_transfer_lock,
          privacy: row.privacy_enabled,
          pendingPrivacy: row.pending_privacy,
          delegation: row.delegation_status,
          registryStatus: row.registry_status,
          registryCheckedAt: row.registry_checked_at,
          createdAt: row.created_at,
        }),
      ),
  }
}

// ── The figures ────────────────────────────────────────────────────────────

const count = z.coerce.number().int().nonnegative().catch(0)

const statsSchema = z.object({
  byTldStatus: z.array(z.object({ tld: z.string(), status: z.string(), count })),
  expiries: z.object({
    expired: count,
    d30: count,
    d60: count,
    d90: count,
    autoOn90: count,
    autoOff90: count,
    next: z.string().nullable(),
  }),
  delegation: z.array(z.object({ status: z.string().nullable(), count })),
  registryAutoRenewLabel: z.array(z.object({ mode: z.string().nullable(), count })),
})

export type DomainStats = z.infer<typeof statsSchema>

/** `admin_domain_stats` for the side: by extension and status, expiries, delegation, renewal modes. */
export async function getDomainStats(side: AdminSide): Promise<DomainStats> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_domain_stats', {
    p_test_mode: side === 'test',
  })
  if (error) {
    logger.warn({ what: 'domain stats', code: error.code }, 'admin domains read failed')
    throw new DomainsReadError('domain stats')
  }
  const parsed = statsSchema.safeParse(data)
  if (!parsed.success) {
    logger.warn({ what: 'domain stats', issues: parsed.error.issues.length }, 'unexpected shape')
    throw new DomainsReadError('domain stats')
  }
  return parsed.data
}

// ── One domain ─────────────────────────────────────────────────────────────

export type DomainRecord = DomainListRow & {
  orderItemId: string | null
  registeredAt: string | null
  updatedAt: string | null
  nameservers: string[]
  pendingNameservers: string[] | null
  previousNameservers: string[] | null
  presetId: string | null
  delegationCheckedAt: string | null
  registryRenewalMode: string | null
  deepCheckedAt: string | null
  /** The registrant's summary, from the view (§9 B9): never the registrant itself. */
  registrantCountry: string | null
  registrantType: string | null
}

/** A part of the page: its rows, or that it could not be read (shown as its own error state). */
export type Section<T> = { ok: true; data: T } | { ok: false }

export type DomainLine = {
  id: string
  orderId: string
  orderNumber: string | null
  itemType: string
}

export type DomainPreset = { id: string; provider: string }

export type DomainJob = {
  id: string
  kind: string
  status: string
  lastErrorCode: string | null
  attempts: number
  createdAt: string
  updatedAt: string
}

export type NameserverChange = {
  id: number
  before: string[] | null
  after: string[]
  changedAt: string
}

export type DomainDrift = {
  id: number
  kind: string
  ours: string
  registry: string
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
}

export type DomainEvent = { id: number; eventType: string; actorType: string; createdAt: string }

/**
 * The gateway heartbeat a deep sync needs. `service_heartbeats` has no side,
 * so a test administrator is not shown it (§2.3) — and is not asked about it.
 */
export type GatewayBeat =
  | { kind: 'hidden' }
  | { kind: 'read'; beatAt: string | null }
  | { kind: 'failed' }

export type DomainDetail = {
  domain: DomainRecord
  line: Section<DomainLine | null>
  preset: Section<DomainPreset | null>
  jobs: Section<{ rows: DomainJob[]; total: number }>
  history: Section<NameserverChange[]>
  drift: Section<DomainDrift[]>
  events: Section<DomainEvent[]>
  gateway: GatewayBeat
}

export const JOBS_SHOWN = 10
export const HISTORY_SHOWN = 20
export const DRIFT_SHOWN = 20
export const EVENTS_SHOWN = 50

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await load() }
  } catch {
    return { ok: false }
  }
}

async function readDomainRecord(db: AdminDb, id: string): Promise<DomainRecord | null> {
  const row = read(
    'domain',
    await db
      .from('admin_domains_v')
      .select(
        'id, domain_name, tld, source, test_mode, user_id, order_item_id, local_status, registered_at, expires_at, auto_renew, transfer_lock, pending_transfer_lock, privacy_enabled, pending_privacy, nameservers, pending_nameservers, previous_nameservers, nameserver_preset_id, delegation_status, delegation_checked_at, registry_status, registry_renewal_mode, registry_checked_at, deep_checked_at, created_at, updated_at, registrant_country, registrant_type',
      )
      .eq('id', id)
      .maybeSingle(),
  )
  if (!row?.id || !row.domain_name) return null
  return {
    id: row.id,
    name: row.domain_name,
    tld: row.tld,
    source: row.source,
    testMode: row.test_mode === true,
    userId: row.user_id,
    status: row.local_status,
    expiresAt: row.expires_at,
    autoRenew: row.auto_renew,
    transferLock: row.transfer_lock,
    pendingTransferLock: row.pending_transfer_lock,
    privacy: row.privacy_enabled,
    pendingPrivacy: row.pending_privacy,
    delegation: row.delegation_status,
    registryStatus: row.registry_status,
    registryCheckedAt: row.registry_checked_at,
    createdAt: row.created_at,
    orderItemId: row.order_item_id,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    nameservers: row.nameservers ?? [],
    pendingNameservers: row.pending_nameservers,
    previousNameservers: row.previous_nameservers,
    presetId: row.nameserver_preset_id,
    delegationCheckedAt: row.delegation_checked_at,
    registryRenewalMode: row.registry_renewal_mode,
    deepCheckedAt: row.deep_checked_at,
    registrantCountry: row.registrant_country,
    registrantType: row.registrant_type,
  }
}

async function readLine(db: AdminDb, id: string): Promise<DomainLine | null> {
  const row = read(
    'domain line',
    await db
      .from('order_items')
      .select('id, order_id, item_type, orders(order_number)')
      .eq('id', id)
      .maybeSingle(),
  )
  if (!row) return null
  const order = row.orders as { order_number?: string | null } | null
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: order?.order_number ?? null,
    itemType: row.item_type,
  }
}

async function readPreset(db: AdminDb, id: string): Promise<DomainPreset | null> {
  const row = read(
    'domain preset',
    await db.from('nameserver_presets').select('id, provider').eq('id', id).maybeSingle(),
  )
  return row ? { id: row.id, provider: row.provider } : null
}

async function readJobs(db: AdminDb, id: string): Promise<{ rows: DomainJob[]; total: number }> {
  const answer = await db
    .from('jobs')
    .select('id, kind, status, last_error_code, attempts, created_at, updated_at', {
      count: 'exact',
    })
    .eq('domain_id', id)
    .order('created_at', { ascending: false })
    .limit(JOBS_SHOWN)
  const rows = read('domain jobs', answer) ?? []
  return {
    total: answer.count ?? rows.length,
    rows: rows.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      lastErrorCode: job.last_error_code,
      attempts: job.attempts,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    })),
  }
}

async function readHistory(db: AdminDb, id: string): Promise<NameserverChange[]> {
  const rows = read(
    'nameserver history',
    await db
      .from('domain_nameserver_history')
      .select('id, before, after, changed_at')
      .eq('domain_id', id)
      .order('changed_at', { ascending: false })
      .limit(HISTORY_SHOWN),
  )
  return (rows ?? []).map((row) => ({
    id: row.id,
    before: row.before,
    after: row.after,
    changedAt: row.changed_at,
  }))
}

async function readDrift(db: AdminDb, id: string): Promise<DomainDrift[]> {
  const rows = read(
    'domain drift',
    await db
      .from('registry_drift')
      .select('id, kind, detail, first_seen_at, last_seen_at, resolved_at')
      .eq('domain_id', id)
      .order('last_seen_at', { ascending: false })
      .limit(DRIFT_SHOWN),
  )
  return (rows ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    // B5's words for the reconcile's detail: never the raw JSON.
    ...driftComparison(row.kind, row.detail),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  }))
}

async function readEvents(db: AdminDb, id: string): Promise<DomainEvent[]> {
  const rows = read(
    'domain events',
    await db
      .from('domain_events')
      .select('id, event_type, actor_type, created_at')
      .eq('domain_id', id)
      .order('created_at', { ascending: false })
      .limit(EVENTS_SHOWN),
  )
  return (rows ?? []).map((event) => ({
    id: event.id,
    eventType: event.event_type,
    actorType: event.actor_type,
    createdAt: event.created_at,
  }))
}

async function readGateway(
  admin: AdminPrincipal,
  db: AdminDb,
  side: AdminSide,
): Promise<GatewayBeat> {
  if (admin.testOnly) return { kind: 'hidden' }
  try {
    const row = read(
      'gateway heartbeat',
      await db
        .from('service_heartbeats')
        .select('name, beat_at')
        .eq('name', gatewayHeartbeat(side))
        .maybeSingle(),
    )
    return { kind: 'read', beatAt: row?.beat_at ?? null }
  } catch {
    return { kind: 'failed' }
  }
}

/** One domain with what its page shows, or null when this side has no such domain. */
export async function getDomain(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<DomainDetail | null> {
  const db = adminDb(admin, side)
  const domain = await readDomainRecord(db, id)
  if (!domain) return null
  const domainSide: AdminSide = domain.testMode ? 'test' : 'live'
  const [line, preset, jobs, history, drift, events, gateway] = await Promise.all([
    domain.orderItemId
      ? section(() => readLine(db, domain.orderItemId as string))
      : Promise.resolve({ ok: true as const, data: null }),
    domain.presetId
      ? section(() => readPreset(db, domain.presetId as string))
      : Promise.resolve({ ok: true as const, data: null }),
    section(() => readJobs(db, id)),
    section(() => readHistory(db, id)),
    section(() => readDrift(db, id)),
    section(() => readEvents(db, id)),
    readGateway(admin, db, domainSide),
  ])
  return { domain, line, preset, jobs, history, drift, events, gateway }
}
