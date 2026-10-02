import 'server-only'

import { createHash } from 'node:crypto'
import {
  type PricingInputs,
  priceSslProducts,
  type SslPricing,
  type SslProductRecord,
} from '@dr/shared'
import { cacheLife, cacheTag } from 'next/cache'
import { logger } from '@/lib/logger'
import { isMissingTable } from '@/lib/supabase/missing-table'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * The certificates we sell, priced (FR-SSL-2). The same three inputs as a
 * domain price — the supplier's cost (ssl_products, synced), the rate
 * (fx_rates) and the margin (pricing_settings) — and the same rule: if any
 * is missing, no price is shown (N5b).
 *
 * Its own read, cached under the same `pricing` tag as the domain
 * catalogue, so a problem with SSL products can never withhold domain prices.
 */
export type SslCatalogue = {
  products: SslPricing[]
  /** The active rate a cart quote records it was priced at (FR-C4). */
  rateId: string
  vatPct: number
  /** Changes whenever any certificate price does (the pricing refresh compares it). */
  version: string
}

export async function getSslCatalogue(): Promise<SslCatalogue | null> {
  try {
    return await loadSslCatalogue()
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'SSL pricing read failed — withholding certificate prices for this request',
    )
    return null
  }
}

/** Cached; a failed query throws, which is never cached (see loadPricedCatalogue). */
export async function loadSslCatalogue(): Promise<SslCatalogue | null> {
  'use cache'
  cacheTag('pricing')
  cacheLife('hours')
  return readSslCatalogue()
}

/** The same read, never cached. */
export async function readSslCatalogue(): Promise<SslCatalogue | null> {
  const supabase = createServiceClient()
  const [rate, settings, products] = await Promise.all([
    supabase
      .from('fx_rates')
      .select('id, costing_rate, buffer_pct')
      .eq('status', 'active')
      .maybeSingle(),
    supabase.from('pricing_settings').select('margin_ngn, icann_fee_usd, vat_pct').maybeSingle(),
    supabase.from('ssl_products').select('*').eq('is_sellable', true).order('create_usd'),
  ])
  // Before migration 39 there is nothing to sell: missing data, not a failure.
  if (isMissingTable(products.error)) return null
  for (const [table, error] of [
    ['fx_rates', rate.error],
    ['pricing_settings', settings.error],
    ['ssl_products', products.error],
  ] as const) {
    if (error) throw new Error(`${table}: ${error.message}`)
  }
  if (!rate.data || !settings.data) return null

  const inputs: PricingInputs = {
    fxRate: Number(rate.data.costing_rate),
    fxBufferPct: Number(rate.data.buffer_pct),
    marginNgn: Number(settings.data.margin_ngn),
    icannFeeUsd: Number(settings.data.icann_fee_usd),
  }
  const records: SslProductRecord[] = (products.data ?? []).flatMap((row) =>
    // Unsynced: no name or shape yet, so nothing to sell (N5b).
    row.name && row.is_wildcard !== null && row.is_multi_domain !== null
      ? [
          {
            productCode: row.product_code,
            name: row.name,
            vendor: row.vendor ?? '',
            validationType: row.validation_type ?? 'DV',
            isWildcard: row.is_wildcard,
            isMultiDomain: row.is_multi_domain,
            includedNames: row.included_names ?? 1,
            isReissueFree: row.is_reissue_free ?? false,
            createUsd: row.create_usd === null ? null : Number(row.create_usd),
          },
        ]
      : [],
  )
  const priced = {
    products: priceSslProducts(records, inputs),
    rateId: rate.data.id as string,
    vatPct: Number(settings.data.vat_pct),
  }
  return {
    ...priced,
    version: createHash('sha256').update(JSON.stringify(priced)).digest('hex').slice(0, 16),
  }
}
