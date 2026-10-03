import 'server-only'

import { usdToCents } from '@dr/shared/admin'
import { cache } from 'react'
import { pageRange } from '@/features/admin/lib/list-params'
import type { Limits } from '@/features/admin/lib/settings-limits'
import type { ExtensionsSearch } from '@/features/admin/lib/settings-params'
import {
  checkDetail,
  type DraftRow,
  type PresetRow,
  type PresetUsage,
} from '@/features/admin/lib/settings-presets'
import type { AdminSide } from '@/features/admin/lib/side'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { type AdminPrincipal, adminDb } from './session'

/**
 * The Settings pages' reads (docs/ADMIN-SPEC.md §5.2 B13, D4). The rows the
 * storefront already shows — extensions, SSL products, presets and their
 * drafts — come through `adminDb`; the counts per side and the admins list
 * are `admin_*` functions called as the admin, which check who is asking and
 * keep a test admin to the test side and its own row. `ops_settings` has no
 * side and holds the money limits, so a test admin is never shown it. Every
 * read answers null when it could not be made: the page shows its error
 * state rather than a wrong number.
 */

const warn = (error: { code?: string } | null, what: string) =>
  logger.warn({ code: error?.code ?? 'unknown' }, what)

const RANGE_NOT_SATISFIABLE = 'PGRST103'

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value))
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const bool = (value: unknown): boolean => value === true
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

// ── Limits ──────────────────────────────────────────────────────────────────

/**
 * The 11 limits, each in the unit the wrapper takes. The float alert is
 * stored in dollars (`float_alert_usd`, numeric(10,2)); it becomes integer
 * cents here, read as decimal text by `usdToCents` — the one edge where USD
 * becomes cents (D24) — so nothing past this line sees a dollar float.
 */
export async function getLimits(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<Limits | 'hidden' | null> {
  if (admin.testOnly) return 'hidden'
  const { data, error } = await adminDb(admin, side)
    .from('ops_settings')
    .select(
      'auto_refund_max_kobo, auto_refund_daily_max_kobo, refund_delay_minutes, stuck_order_minutes, max_domains_per_account_day, velocity_new_max, velocity_trusted_max, velocity_standard_after_days, velocity_trusted_after_days, velocity_trusted_after_paid_orders, float_alert_usd',
    )
    .limit(1)
    .maybeSingle()
  if (error || !data) {
    warn(error, 'admin settings: limits unavailable')
    return null
  }
  try {
    const limits: Limits = {
      auto_refund_max_kobo: num(data.auto_refund_max_kobo),
      auto_refund_daily_max_kobo: num(data.auto_refund_daily_max_kobo),
      refund_delay_minutes: num(data.refund_delay_minutes),
      stuck_order_minutes: num(data.stuck_order_minutes),
      max_domains_per_account_day: num(data.max_domains_per_account_day),
      velocity_new_max: num(data.velocity_new_max),
      velocity_trusted_max: num(data.velocity_trusted_max),
      velocity_standard_after_days: num(data.velocity_standard_after_days),
      velocity_trusted_after_days: num(data.velocity_trusted_after_days),
      velocity_trusted_after_paid_orders: num(data.velocity_trusted_after_paid_orders),
      float_alert_cents: usdToCents(data.float_alert_usd as number | string),
    }
    if (!Object.values(limits).every((value) => Number.isSafeInteger(value))) throw new Error()
    return limits
  } catch {
    logger.error('admin settings: ops_settings answered an unexpected shape')
    return null
  }
}

// ── Extensions ──────────────────────────────────────────────────────────────

export type ExtensionRow = {
  name: string
  isSellable: boolean
  isPaused: boolean
  pausedReason: string | null
  featuredRank: number | null
  featuredTagline: string | null
  isCountryCode: boolean
  isTransferable: boolean | null
  syncedAt: string | null
}

type TldRecord = Record<string, unknown>

function toExtension(row: TldRecord): ExtensionRow {
  return {
    name: String(row.name),
    isSellable: bool(row.is_sellable),
    isPaused: bool(row.is_paused),
    pausedReason: text(row.paused_reason),
    featuredRank:
      row.featured_rank === null || row.featured_rank === undefined ? null : num(row.featured_rank),
    featuredTagline: text(row.featured_tagline),
    isCountryCode: bool(row.is_country_code),
    isTransferable:
      row.is_transferable === null || row.is_transferable === undefined
        ? null
        : bool(row.is_transferable),
    syncedAt: text(row.synced_at),
  }
}

/** Each status chip as a PostgREST condition; several chips show any of them. */
const STATUS_CONDITION = {
  paused: 'is_paused.eq.true',
  featured: 'featured_rank.not.is.null',
  unsold: 'is_sellable.eq.false',
  country: 'is_country_code.eq.true',
} as const

export type ExtensionList = { rows: ExtensionRow[]; total: number }

/** One page of extensions: filtered by name and chips, sorted, with a total. */
export async function listExtensions(
  admin: AdminPrincipal,
  side: AdminSide,
  params: ExtensionsSearch,
): Promise<ExtensionList | null> {
  const db = adminDb(admin, side)
  const filtered = (head: boolean) => {
    let query = db
      .from('tlds')
      .select(
        'name, is_sellable, is_paused, paused_reason, featured_rank, featured_tagline, is_country_code, is_transferable, synced_at',
        { count: 'exact', ...(head ? { head: true } : {}) },
      )
    if (params.q) query = query.ilike('name', `${params.q}%`)
    if (params.status.length > 0) {
      query = query.or(params.status.map((status) => STATUS_CONDITION[status]).join(','))
    }
    return query
  }
  const ascending = params.dir === 'asc'
  let query = filtered(false)
  if (params.sort === 'rank') {
    query = query.order('featured_rank', { ascending, nullsFirst: false })
  } else if (params.sort === 'synced') {
    query = query.order('synced_at', { ascending, nullsFirst: false })
  } else {
    query = query.order('name', { ascending })
  }
  if (params.sort !== 'name') query = query.order('name', { ascending: true })
  const { from, to } = pageRange(params)
  const answer = await query.range(from, to)
  if (answer.error?.code === RANGE_NOT_SATISFIABLE) {
    const counted = await filtered(true)
    if (counted.error) {
      warn(counted.error, 'admin settings: extension count unavailable')
      return null
    }
    return { rows: [], total: counted.count ?? 0 }
  }
  if (answer.error) {
    warn(answer.error, 'admin settings: extensions unavailable')
    return null
  }
  return {
    rows: ((answer.data ?? []) as TldRecord[]).map(toExtension),
    total: answer.count ?? 0,
  }
}

/** One extension, for its open controls; null when there is none by that name. */
export async function getExtension(
  admin: AdminPrincipal,
  side: AdminSide,
  name: string,
): Promise<ExtensionRow | null | 'error'> {
  const { data, error } = await adminDb(admin, side)
    .from('tlds')
    .select(
      'name, is_sellable, is_paused, paused_reason, featured_rank, featured_tagline, is_country_code, is_transferable, synced_at',
    )
    .eq('name', name)
    .maybeSingle()
  if (error) {
    warn(error, 'admin settings: extension unavailable')
    return 'error'
  }
  return data ? toExtension(data as TldRecord) : null
}

export type FeaturedRank = { name: string; rank: number }

/** Every featured extension and its rank: each rank belongs to one extension. */
export async function getFeaturedRanks(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<FeaturedRank[] | null> {
  const { data, error } = await adminDb(admin, side)
    .from('tlds')
    .select('name, featured_rank')
    .not('featured_rank', 'is', null)
    .order('featured_rank', { ascending: true })
  if (error) {
    warn(error, 'admin settings: featured ranks unavailable')
    return null
  }
  return ((data ?? []) as TldRecord[]).map((row) => ({
    name: String(row.name),
    rank: num(row.featured_rank),
  }))
}

/**
 * Domains held on each extension on one side (`admin_tld_held_counts`):
 * active, in grace, in redemption, pending deletion or verification; demo
 * rows never count. A test admin is kept to the test side by SQL.
 */
export const getHeldCounts = cache(async (side: AdminSide): Promise<Map<string, number> | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_tld_held_counts', {
    p_test_mode: side === 'test',
  })
  if (error) {
    warn(error, 'admin settings: held counts unavailable')
    return null
  }
  const counts = new Map<string, number>()
  for (const row of (data ?? []) as { tld: unknown; held: unknown }[]) {
    if (typeof row.tld === 'string') counts.set(row.tld, num(row.held))
  }
  return counts
})

// ── SSL products ────────────────────────────────────────────────────────────

export type SslProductRow = {
  productCode: string
  name: string | null
  vendor: string | null
  validationType: string | null
  isWildcard: boolean | null
  isMultiDomain: boolean | null
  includedNames: number | null
  maxNames: number | null
  isSellable: boolean
  syncedAt: string | null
  /** DomainNameAPI lists a price: only then can it go on sale. */
  hasPrice: boolean
}

/**
 * Every SSL product, on sale first. Whether a product has a price is read as
 * a filter (`create_usd is null`), so no dollar figure is read here (D24):
 * the price itself is the pricing page's.
 */
export async function listSslProducts(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<SslProductRow[] | null> {
  const db = adminDb(admin, side)
  const [products, unpriced] = await Promise.all([
    db
      .from('ssl_products')
      .select(
        'product_code, name, vendor, validation_type, is_wildcard, is_multi_domain, included_names, max_names, is_sellable, synced_at',
      )
      .order('is_sellable', { ascending: false })
      .order('name', { ascending: true, nullsFirst: false })
      .order('product_code', { ascending: true }),
    db.from('ssl_products').select('product_code').is('create_usd', null),
  ])
  if (products.error || unpriced.error) {
    warn(products.error ?? unpriced.error, 'admin settings: ssl products unavailable')
    return null
  }
  const noPrice = new Set(
    ((unpriced.data ?? []) as { product_code: unknown }[]).map((row) => String(row.product_code)),
  )
  return ((products.data ?? []) as Record<string, unknown>[]).map((row) => {
    const code = String(row.product_code)
    const maybeBool = (value: unknown) =>
      value === null || value === undefined ? null : bool(value)
    const maybeNum = (value: unknown) => (value === null || value === undefined ? null : num(value))
    return {
      productCode: code,
      name: text(row.name),
      vendor: text(row.vendor),
      validationType: text(row.validation_type),
      isWildcard: maybeBool(row.is_wildcard),
      isMultiDomain: maybeBool(row.is_multi_domain),
      includedNames: maybeNum(row.included_names),
      maxNames: maybeNum(row.max_names),
      isSellable: bool(row.is_sellable),
      syncedAt: text(row.synced_at),
      hasPrice: !noPrice.has(code),
    }
  })
}

// ── Presets ─────────────────────────────────────────────────────────────────

function toPreset(row: Record<string, unknown>): PresetRow {
  return {
    id: String(row.id),
    provider: String(row.provider),
    nameservers: list(row.nameservers),
    assignsPerZone: bool(row.assigns_per_zone),
    sourceUrl: String(row.source_url ?? ''),
    notes: text(row.notes),
    verifiedAt: text(row.verified_at),
    lastCheckedAt: text(row.last_checked_at),
    checkFailedSince: text(row.check_failed_since),
    autoHiddenAt: text(row.auto_hidden_at),
    isHidden: bool(row.is_hidden),
    registrarDefaultFor: text(row.registrar_default_for),
    lastCheck: checkDetail(row.last_check),
  }
}

function toDraft(row: Record<string, unknown>): DraftRow {
  return {
    id: String(row.id),
    presetId: text(row.preset_id),
    provider: String(row.provider),
    nameservers: list(row.nameservers),
    sourceUrl: String(row.source_url ?? ''),
    notes: text(row.notes),
    assignsPerZone: bool(row.assigns_per_zone),
    savedBy: String(row.saved_by ?? ''),
    savedAt: String(row.saved_at ?? ''),
    checkOk: row.check_ok === null || row.check_ok === undefined ? null : bool(row.check_ok),
    checkedAt: text(row.checked_at),
    checkDetail: checkDetail(row.check_detail),
    publishedAt: text(row.published_at),
    discardedAt: text(row.discarded_at),
  }
}

/** Every preset, registrar defaults included (shown read-only), by provider. */
export async function listPresets(
  admin: AdminPrincipal,
  side: AdminSide,
): Promise<PresetRow[] | null> {
  const { data, error } = await adminDb(admin, side)
    .from('nameserver_presets')
    .select(
      'id, provider, nameservers, assigns_per_zone, source_url, notes, verified_at, last_checked_at, check_failed_since, auto_hidden_at, is_hidden, registrar_default_for, last_check',
    )
    .order('provider', { ascending: true })
  if (error) {
    warn(error, 'admin settings: presets unavailable')
    return null
  }
  return ((data ?? []) as Record<string, unknown>[]).map(toPreset)
}

/** One preset, or null when there is none with that id. */
export async function getPreset(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<PresetRow | null | 'error'> {
  const { data, error } = await adminDb(admin, side)
    .from('nameserver_presets')
    .select(
      'id, provider, nameservers, assigns_per_zone, source_url, notes, verified_at, last_checked_at, check_failed_since, auto_hidden_at, is_hidden, registrar_default_for, last_check',
    )
    .eq('id', id)
    .maybeSingle()
  if (error) {
    warn(error, 'admin settings: preset unavailable')
    return 'error'
  }
  return data ? toPreset(data as Record<string, unknown>) : null
}

/**
 * Drafts (D21): every open one for the list, or one preset's — open and
 * past — newest first. A draft holds a host's nameservers, source and check,
 * no customer data; a test admin may read them (§9 B13).
 */
export async function listDrafts(
  admin: AdminPrincipal,
  side: AdminSide,
  scope: { open: true } | { presetId: string },
): Promise<DraftRow[] | null> {
  let query = adminDb(admin, side)
    .from('nameserver_preset_drafts')
    .select(
      'id, preset_id, provider, nameservers, source_url, notes, assigns_per_zone, saved_by, saved_at, check_ok, checked_at, check_detail, published_at, discarded_at',
    )
  query =
    'open' in scope
      ? query.is('published_at', null).is('discarded_at', null)
      : query.eq('preset_id', scope.presetId)
  const { data, error } = await query.order('saved_at', { ascending: false }).limit(50)
  if (error) {
    warn(error, 'admin settings: preset drafts unavailable')
    return null
  }
  return ((data ?? []) as Record<string, unknown>[]).map(toDraft)
}

/** One draft by id: a new host's lives at its own page until it is published. */
export async function getDraft(
  admin: AdminPrincipal,
  side: AdminSide,
  id: string,
): Promise<DraftRow | null | 'error'> {
  const { data, error } = await adminDb(admin, side)
    .from('nameserver_preset_drafts')
    .select(
      'id, preset_id, provider, nameservers, source_url, notes, assigns_per_zone, saved_by, saved_at, check_ok, checked_at, check_detail, published_at, discarded_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (error) {
    warn(error, 'admin settings: preset draft unavailable')
    return 'error'
  }
  return data ? toDraft(data as Record<string, unknown>) : null
}

/**
 * Who uses each preset on one side (`admin_preset_usage`): domains on it,
 * orders and order lines that chose it — the blast radius of a change.
 */
export const getPresetUsage = cache(
  async (side: AdminSide): Promise<Map<string, PresetUsage> | null> => {
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('admin_preset_usage', {
      p_test_mode: side === 'test',
    })
    if (error) {
      warn(error, 'admin settings: preset usage unavailable')
      return null
    }
    const usage = new Map<string, PresetUsage>()
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      if (typeof row.preset_id !== 'string') continue
      usage.set(row.preset_id, {
        domains: num(row.domains),
        orders: num(row.orders),
        lines: num(row.lines),
      })
    }
    return usage
  },
)

// ── Admins ──────────────────────────────────────────────────────────────────

export type AdminRow = {
  label: string
  role: string
  testOnly: boolean
  addedAt: string | null
  revokedAt: string | null
  pinnedFactors: number
  verifiedPinnedFactors: number
  lastChangeAt: string | null
}

/**
 * `admin_list_admins`: labels, roles and device counts — no ids, no emails.
 * A test admin is answered its own row only, by SQL.
 */
export async function listAdmins(): Promise<AdminRow[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_list_admins')
  if (error) {
    warn(error, 'admin settings: admins unavailable')
    return null
  }
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    label: String(row.label),
    role: String(row.role),
    testOnly: bool(row.test_only),
    addedAt: text(row.added_at),
    revokedAt: text(row.revoked_at),
    pinnedFactors: num(row.pinned_factors),
    verifiedPinnedFactors: num(row.verified_pinned_factors),
    lastChangeAt: text(row.last_change_at),
  }))
}
