import 'server-only'

import { createHash } from 'node:crypto'
import {
  effectiveFxRate,
  type PricingInputs,
  priceCatalogue,
  type TldPricing,
  type TldRecord,
} from '@dr/shared'
import { cacheLife, cacheTag } from 'next/cache'
import { logger } from '@/lib/logger'
import { allRows } from '@/lib/supabase/all-rows'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Everything the storefront needs to show a price.
 *
 * Costs come from the synced catalogue, the rate from the FX feed, margin and
 * fees from pricing settings. No pricing input is hardcoded anywhere: if any
 * of the three is missing, prices are withheld rather than guessed.
 */
/** A pricing query that failed in transit, as opposed to returning no data. */
export class PricingReadError extends Error {
  constructor(table: string, message: string) {
    super(`${table}: ${message}`)
    this.name = 'PricingReadError'
  }
}

export type PricedCatalogue = {
  tlds: TldPricing[]
  /** Merchandised extensions in display order, from `tlds.featured_rank`. */
  featured: (TldPricing & { tagline: string | null })[]
  /** The rate customers are charged at, after any buffer. */
  effectiveRate: number
  rateSource: string
  rateUpdatedAt: Date
  /** The active rate row — what a cart quote records it was priced at (FR-C4). */
  rateId: string
  /** VAT on our supply, from pricing settings (N5b). Added at checkout, never in list prices. */
  vatPct: number
  /** A fingerprint of every price shown: changes whenever any of them does. */
  version: string
}

/** A period column as numbers; absent (before migration 37) or null means none listed. */
function periodList(value: readonly (number | string)[] | null | undefined): number[] | null {
  return Array.isArray(value) ? value.map(Number) : null
}

/**
 * The priced catalogue, or `null` when prices must be withheld (N5b).
 *
 * A read that fails in transit (Supabase unreachable, a dropped connection)
 * withholds prices for this request only. Missing data — no active rate, no
 * pricing settings, an empty catalogue — withholds them until the cache
 * refreshes, which is fine: it takes a job writing new data to fix, and that
 * job revalidates the `pricing` tag.
 */
export async function getPricedCatalogue(): Promise<PricedCatalogue | null> {
  try {
    return await loadPricedCatalogue()
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'pricing read failed — withholding prices for this request',
    )
    return null
  }
}

/**
 * The cached read behind getPricedCatalogue. Exported for tests; call
 * getPricedCatalogue instead.
 *
 * A failed query throws rather than returning `null`, because a throw is never
 * cached: a single dropped connection used to cache "no prices" for an hour,
 * across every page that shows one. A `null` return is cached, so it is kept
 * for data that is genuinely missing.
 */
export async function loadPricedCatalogue(): Promise<PricedCatalogue | null> {
  'use cache'
  // Rate and catalogue both change at most daily and are identical for every
  // visitor. /api/pricing/refresh expires this tag when a job writes new data,
  // so a day's lifetime only bounds a missed refresh; an hour re-rendered
  // every extension page hourly for crawlers (Vercel CPU pause, 31 Oct 2026).
  cacheTag('pricing')
  cacheLife('days')
  return readPricedCatalogue()
}

/**
 * The same read, never cached — what the prices are right now. The refresh
 * route compares it with the cached copy. Throws on a failed query, as above.
 */
export async function readPricedCatalogue(): Promise<PricedCatalogue | null> {
  // Service client: pricing settings hold the margin, which is not public.
  const supabase = createServiceClient()

  const [rateResult, settingsResult, tldResult] = await Promise.all([
    supabase
      .from('fx_rates')
      .select('id, costing_rate, buffer_pct, source, effective_from')
      .eq('status', 'active')
      .maybeSingle(),
    supabase.from('pricing_settings').select('margin_ngn, icann_fee_usd, vat_pct').maybeSingle(),
    allRows((from, to) =>
      supabase
        .from('tlds')
        // Every column: a database without migration 37's period columns
        // still reads, each row then selling every year from min to max as
        // before — so this can deploy before the migration is applied.
        .select('*')
        .eq('is_sellable', true)
        // Paused extensions are ours to switch off without a deploy — the .ng
        // family is paused while we find a competitive source (PRD R17).
        .eq('is_paused', false)
        .order('name')
        .range(from, to),
    ),
  ])

  // The error message only: it names the table or the network fault, never a
  // person (N13).
  const failed = [
    ['fx_rates', rateResult.error],
    ['pricing_settings', settingsResult.error],
    ['tlds', tldResult.error],
  ] as const
  for (const [table, error] of failed) {
    if (error) throw new PricingReadError(table, error.message)
  }

  if (!rateResult.data) {
    logger.error('no active FX rate — cannot price')
    return null
  }
  if (!settingsResult.data) {
    logger.error('no pricing settings — cannot price')
    return null
  }
  if (!tldResult.data?.length) {
    logger.error('catalogue is empty — cannot price')
    return null
  }

  const inputs: PricingInputs = {
    fxRate: Number(rateResult.data.costing_rate),
    fxBufferPct: Number(rateResult.data.buffer_pct),
    marginNgn: Number(settingsResult.data.margin_ngn),
    icannFeeUsd: Number(settingsResult.data.icann_fee_usd),
  }

  const records: TldRecord[] = tldResult.data.map((row) => ({
    name: row.name as string,
    registerUsd: Number(row.register_usd),
    renewUsd: Number(row.renew_usd),
    transferUsd: row.transfer_usd === null ? null : Number(row.transfer_usd),
    restoreUsd: row.restore_usd === null ? null : Number(row.restore_usd),
    isCountryCode: Boolean(row.is_country_code),
    minPeriod: Number(row.min_period),
    maxPeriod: Number(row.max_period),
    registerPeriods: periodList(row.register_periods),
    renewPeriods: periodList(row.renew_periods),
    redemptionDays: Number(row.redemption_days),
    requiresExtraFields: Boolean(row.requires_extra_fields),
  }))

  const tlds = priceCatalogue(records, inputs)

  const merch = new Map(
    tldResult.data
      .filter((row) => row.featured_rank !== null)
      .map((row) => [
        row.name as string,
        {
          rank: Number(row.featured_rank),
          tagline: (row.featured_tagline as string | null) ?? null,
        },
      ]),
  )
  const featured = tlds
    .filter((t) => merch.has(t.tld))
    .map((t) => ({ ...t, tagline: merch.get(t.tld)?.tagline ?? null }))
    .sort((a, b) => (merch.get(a.tld)?.rank ?? 0) - (merch.get(b.tld)?.rank ?? 0))

  const priced = {
    tlds,
    featured,
    effectiveRate: Math.round(effectiveFxRate(inputs.fxRate, inputs.fxBufferPct)),
    rateSource: rateResult.data.source as string,
    rateUpdatedAt: new Date(rateResult.data.effective_from as string),
    rateId: rateResult.data.id as string,
    vatPct: Number(settingsResult.data.vat_pct),
  }
  return {
    ...priced,
    version: createHash('sha256').update(JSON.stringify(priced)).digest('hex').slice(0, 16),
  }
}
