import { type ActiveRate, effectiveRateFrom, type FxSource } from '@dr/shared'
import { cacheLife, cacheTag } from 'next/cache'
import { logger } from '@/lib/logger'
import { createPublicClient } from '@/lib/supabase/public'

/**
 * The exchange rate the storefront prices against.
 *
 * Read from `fx_rates`, where exactly one row per pair can be active. The row
 * is public-readable because we publish the rate on the pricing page anyway.
 *
 * Returns null when no rate can be determined. Callers MUST handle that by
 * withholding prices — never by substituting a guess. A wrong price is worse
 * than no price on a storefront that sells honest pricing.
 */
export async function getActiveRate(): Promise<ActiveRate | null> {
  'use cache'
  // The rate changes at most once a day and is the same for every visitor, so
  // it is cached rather than queried per request. `fx-rate` is the tag to
  // revalidate when the rate job activates a new rate.
  cacheTag('fx-rate')
  cacheLife('hours')

  const supabase = createPublicClient()

  const { data, error } = await supabase
    .from('fx_rates')
    .select('costing_rate, buffer_pct, source, effective_from')
    .eq('status', 'active')
    .maybeSingle()

  if (error) {
    logger.error({ err: error.message }, 'could not read the active FX rate')
    return null
  }
  if (!data) {
    logger.error('no active FX rate — prices cannot be quoted')
    return null
  }

  return {
    costingRate: Number(data.costing_rate),
    bufferPct: Number(data.buffer_pct),
    source: data.source as FxSource,
    effectiveFrom: new Date(data.effective_from as string),
  }
}

/** The rate as customers see it, after the buffer. */
export function displayRate(active: ActiveRate): number {
  return Math.round(effectiveRateFrom(active))
}
