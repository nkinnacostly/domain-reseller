import 'server-only'

import {
  effectiveFxRate,
  type PricingInputs,
  priceCatalogue,
  type TldPricing,
  type TldRecord,
} from '@dr/shared'
import { cacheLife, cacheTag } from 'next/cache'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Everything the storefront needs to show a price.
 *
 * Costs come from the synced catalogue, the rate from the FX feed, margin and
 * fees from pricing settings. No pricing input is hardcoded anywhere: if any
 * of the three is missing, prices are withheld rather than guessed.
 */
export type PricedCatalogue = {
  tlds: TldPricing[]
  /** The rate customers are charged at, after any buffer. */
  effectiveRate: number
  rateSource: string
  rateUpdatedAt: Date
}

export async function getPricedCatalogue(): Promise<PricedCatalogue | null> {
  'use cache'
  // Rate and catalogue both change at most daily and are identical for every
  // visitor. Revalidate these tags when a job writes new data.
  cacheTag('pricing')
  cacheLife('hours')

  // Service client: pricing settings hold the margin, which is not public.
  const supabase = createServiceClient()

  const [rateResult, settingsResult, tldResult] = await Promise.all([
    supabase
      .from('fx_rates')
      .select('costing_rate, buffer_pct, source, effective_from')
      .eq('status', 'active')
      .maybeSingle(),
    supabase.from('pricing_settings').select('margin_ngn, icann_fee_usd').maybeSingle(),
    supabase
      .from('tlds')
      .select(
        'name, register_usd, renew_usd, transfer_usd, restore_usd, min_period, max_period, redemption_days, requires_extra_fields, is_country_code',
      )
      .eq('is_sellable', true)
      .order('name'),
  ])

  if (rateResult.error || !rateResult.data) {
    logger.error({ err: rateResult.error?.message }, 'no active FX rate — cannot price')
    return null
  }
  if (settingsResult.error || !settingsResult.data) {
    logger.error({ err: settingsResult.error?.message }, 'no pricing settings — cannot price')
    return null
  }
  if (tldResult.error || !tldResult.data?.length) {
    logger.error({ err: tldResult.error?.message }, 'catalogue is empty — cannot price')
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
    redemptionDays: Number(row.redemption_days),
    requiresExtraFields: Boolean(row.requires_extra_fields),
  }))

  return {
    tlds: priceCatalogue(records, inputs),
    effectiveRate: Math.round(effectiveFxRate(inputs.fxRate, inputs.fxBufferPct)),
    rateSource: rateResult.data.source as string,
    rateUpdatedAt: new Date(rateResult.data.effective_from as string),
  }
}

/** The handful of extensions merchandised on the home page. */
export const FEATURED_TLDS = [
  { tld: 'ng', blurb: 'Nigeria, short and unmistakable' },
  { tld: 'com.ng', blurb: 'The trusted Nigerian business address' },
  { tld: 'com', blurb: 'The one everybody types first' },
] as const
