import 'server-only'

import {
  type PricingStatus,
  parsePricingStatus,
  parseRateRows,
  parseSampleTld,
  type RateRow,
  type SampleTld,
} from '@/features/admin/lib/pricing-data'
import { type AdminPrincipal, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'

/**
 * The Pricing & FX pages' reads (docs/ADMIN-SPEC.md §3.2h, §5.2 B12).
 * `admin_pricing_status` — called as the admin, so SQL checks who is asking —
 * answers the settings, the catalogue's counts and each rate's review state.
 * The rest is storefront-public data read through adminDb (`fx_rates` and
 * `tlds` are global and public-safe, so a test administrator reads them
 * too): each rate's own buffer and why it was held, the recent history, and
 * the catalogue row the pages price as their example. Nothing here writes.
 */

/** The extension whose price the pages show before and after a change. */
export const SAMPLE_TLD = 'com'

/** How many rates the history shows. */
export const RECENT_RATES = 10

function warn(error: unknown, message: string) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : error instanceof Error
        ? error.name
        : 'unknown'
  logger.warn({ code }, message)
}

/** Settings, counts and review state; null when it could not be read. */
export async function getPricingStatus(): Promise<PricingStatus | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_pricing_status')
  if (error) {
    warn(error, 'admin pricing status unavailable')
    return null
  }
  const parsed = parsePricingStatus(data)
  if ('issues' in parsed) {
    logger.error({ issues: parsed.issues }, 'admin_pricing_status answered an unexpected shape')
    return null
  }
  return parsed.status
}

/**
 * The active rate and every held one, whole — `admin_pricing_status` leaves
 * out each rate's buffer and why it was held. Null when unreadable.
 */
export async function getCurrentRates(admin: AdminPrincipal): Promise<RateRow[] | null> {
  try {
    const { data, error } = await adminDb(admin, 'live')
      .from('fx_rates')
      .select(
        'id, status, source, costing_rate, buffer_pct, move_pct, review_reason, quoted_at, effective_from, created_at, reviewed_at',
      )
      .in('status', ['active', 'pending_review'])
      .order('quoted_at', { ascending: false })
    if (error) {
      warn(error, 'admin current rates unavailable')
      return null
    }
    const rows = parseRateRows(data)
    if (!rows) logger.error('fx_rates answered an unexpected shape')
    return rows
  } catch (error) {
    warn(error, 'admin current rates refused')
    return null
  }
}

/** The latest rates, newest first, whatever their status. Null when unreadable. */
export async function getRecentRates(admin: AdminPrincipal): Promise<RateRow[] | null> {
  try {
    const { data, error } = await adminDb(admin, 'live')
      .from('fx_rates')
      .select(
        'id, status, source, costing_rate, buffer_pct, move_pct, review_reason, quoted_at, effective_from, created_at, reviewed_at',
      )
      .order('created_at', { ascending: false })
      .limit(RECENT_RATES)
    if (error) {
      warn(error, 'admin recent rates unavailable')
      return null
    }
    const rows = parseRateRows(data)
    if (!rows) logger.error('fx_rates answered an unexpected shape')
    return rows
  } catch (error) {
    warn(error, 'admin recent rates refused')
    return null
  }
}

/**
 * The example extension's catalogue row: its yearly costs become whole cents
 * here, at the edge (D24), and go only into the shared pricing functions —
 * the same inputs the storefront prices it from (N5b). Null when it is
 * missing, unreadable or not cent-exact: the pages then show no example.
 */
export async function getSampleTld(admin: AdminPrincipal): Promise<SampleTld | null> {
  try {
    const { data, error } = await adminDb(admin, 'live')
      .from('tlds')
      .select(
        'name, register_usd, renew_usd, is_country_code, min_period, max_period, register_periods, renew_periods, is_sellable, is_paused',
      )
      .eq('name', SAMPLE_TLD)
      .limit(1)
    if (error) {
      warn(error, 'admin sample extension unavailable')
      return null
    }
    return parseSampleTld(Array.isArray(data) ? data[0] : null)
  } catch (error) {
    warn(error, 'admin sample extension refused')
    return null
  }
}

/** When the pricing settings last changed; null when unknown. Who changed them is in the audit log. */
export async function getSettingsChangedAt(admin: AdminPrincipal): Promise<string | null> {
  try {
    const { data, error } = await adminDb(admin, 'live')
      .from('pricing_settings')
      .select('updated_at')
      .limit(1)
    if (error) {
      warn(error, 'admin pricing settings time unavailable')
      return null
    }
    const at = Array.isArray(data) ? (data[0] as { updated_at?: unknown } | undefined) : undefined
    return typeof at?.updated_at === 'string' ? at.updated_at : null
  } catch (error) {
    warn(error, 'admin pricing settings time refused')
    return null
  }
}
