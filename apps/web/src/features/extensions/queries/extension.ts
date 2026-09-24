import 'server-only'

import type { TldPricing } from '@dr/shared'
import { cacheLife, cacheTag } from 'next/cache'
import { POPULAR_TLDS } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { logger } from '@/lib/logger'
import { allRows } from '@/lib/supabase/all-rows'
import { createPublicClient } from '@/lib/supabase/public'
import { type ExtensionFacts, factsFromPricing } from '../lib/extension'

/**
 * Everything the catalogue says about every extension we sell, apart from
 * costs, in one read. Cookie-free publishable-key client: RLS shows only
 * sellable, unpaused extensions, the same rule the priced catalogue applies.
 *
 * Cached like the pricing page — the same `pricing` tag, so a catalogue job
 * that refreshes prices refreshes these pages too. A failed read throws, and a
 * throw is never cached.
 */
export async function loadCatalogueFacts(): Promise<ExtensionFacts[]> {
  'use cache'
  cacheTag('pricing')
  cacheLife('hours')

  const client = createPublicClient()
  const { data, error } = await allRows((from, to) =>
    client
      .from('tlds')
      .select(
        'name, is_country_code, min_period, max_period, requires_extra_fields, min_chars, max_chars, is_transferable, featured_tagline',
      )
      .order('name')
      .range(from, to),
  )
  if (error) throw new Error(`tlds: ${error.message}`)

  return (data ?? []).map((row) => ({
    tld: row.name,
    isCountryCode: Boolean(row.is_country_code),
    minPeriod: Number(row.min_period),
    maxPeriod: Number(row.max_period),
    requiresExtraFields: Boolean(row.requires_extra_fields),
    minChars: row.min_chars ?? null,
    maxChars: row.max_chars ?? null,
    isTransferable: row.is_transferable ?? null,
    tagline: row.featured_tagline ?? null,
  }))
}

export type ExtensionPage =
  | {
      kind: 'found'
      facts: ExtensionFacts
      /** Null when prices are withheld (N5b). */
      pricing: TldPricing | null
      vatPct: number | null
    }
  /** Not an extension we sell — unknown, paused or no longer offered. */
  | { kind: 'missing' }
  /** Neither the catalogue nor the prices could be read, so we cannot say. */
  | { kind: 'unavailable' }

/**
 * An extension's page data. The two reads back each other up: if the price
 * list is down the page still describes the extension (prices withheld), and
 * if the catalogue read fails the priced entry supplies the basic facts.
 */
export async function getExtensionPage(tld: string): Promise<ExtensionPage> {
  const [facts, priced] = await Promise.all([
    loadCatalogueFacts().catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'extension facts could not be read',
      )
      return null
    }),
    getPricedCatalogue(),
  ])

  const pricing = priced?.tlds.find((entry) => entry.tld === tld) ?? null
  const known = facts?.find((entry) => entry.tld === tld) ?? (pricing && factsFromPricing(pricing))

  if (known) return { kind: 'found', facts: known, pricing, vatPct: priced?.vatPct ?? null }
  if (!facts && !priced) return { kind: 'unavailable' }
  return { kind: 'missing' }
}

/**
 * Prerendered at build: the featured extensions, then the ones people here
 * recognise, where we sell them. Every other extension renders on its first
 * visit and is kept from then on. Cache Components needs at least one.
 */
export async function extensionStaticParams(): Promise<{ tld: string }[]> {
  const priced = await getPricedCatalogue()
  const sold = new Set(priced?.tlds.map((entry) => entry.tld) ?? [])
  const wanted = [...(priced?.featured.map((entry) => entry.tld) ?? []), ...POPULAR_TLDS]
  const tlds = [...new Set(wanted)].filter((tld) => sold.has(tld))
  return (tlds.length > 0 ? tlds : ['com']).map((tld) => ({ tld }))
}
