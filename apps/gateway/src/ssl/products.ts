import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { getJson } from '../lib/http'
import { SSL_BASE_URL } from './client'

/**
 * The SSL product list (`GET /products/ssls`, PRD Appendix E) → `ssl_products`
 * (migration 39). Same rules as the domain catalogue: every change is
 * reported before anything is written, and a listing that cannot be trusted
 * is refused whole (N5b). The sync owns every column but `is_sellable`, which
 * is the owner's.
 *
 * Read on 2 Oct 2026: 35 products, each priced per group (Reseller, Premium,
 * Platinum, VIP) for one period; we buy at Reseller. Two product codes are
 * listed twice (412 with different names and prices, 503 twice the same), so
 * a code is not a key by itself: an ambiguous one is left alone and reported.
 */

/** Our price group at the supplier. */
export const PRICE_GROUP = 'Reseller'

export type RawSslProduct = {
  name?: unknown
  productCode?: unknown
  vendorName?: unknown
  validationType?: unknown
  isWildcard?: unknown
  isMultiDomain?: unknown
  defaultSanCount?: unknown
  maxSanCount?: unknown
  isReissueFree?: unknown
  requiresCsr?: unknown
  prices?: unknown
}

export type SslProductRow = {
  product_code: string
  name: string
  vendor: string
  validation_type: string
  is_wildcard: boolean
  is_multi_domain: boolean
  included_names: number
  max_names: number
  is_reissue_free: boolean
  requires_csr: boolean
  create_usd: number
}

export type CurrentSslProduct = Pick<
  SslProductRow,
  'product_code' | 'name' | 'is_wildcard' | 'is_multi_domain' | 'included_names'
> & { create_usd: number | null; is_sellable: boolean }

/** One period of the Reseller group's `create` price, in USD — or null. */
function resellerPrice(prices: unknown): number | null {
  if (!Array.isArray(prices)) return null
  const group = prices.find(
    (entry) => (entry as { priceGroup?: unknown } | null)?.priceGroup === PRICE_GROUP,
  ) as { create?: unknown } | undefined
  if (!group || !Array.isArray(group.create)) return null
  const yearly = group.create.find(
    (entry) =>
      (entry as { period?: unknown }).period === 1 &&
      (entry as { currency?: unknown }).currency === 'USD',
  ) as { price?: unknown } | undefined
  const price = Number(yearly?.price)
  return Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null

export type ParsedListing = {
  rows: SslProductRow[]
  /** Codes listed more than once with different details: not written. */
  ambiguous: string[]
  /** Listed, but without a code, a name or a Reseller price for one period. */
  unusable: string[]
}

export function toSslRows(items: readonly RawSslProduct[]): ParsedListing {
  const byCode = new Map<string, SslProductRow[]>()
  const unusable: string[] = []
  for (const item of items) {
    const code = text(item.productCode, 16)
    const name = text(item.name, 200)
    const price = resellerPrice(item.prices)
    if (!code || !/^[A-Za-z0-9]{1,16}$/.test(code) || !name || price === null) {
      unusable.push(name ?? code ?? '(unnamed)')
      continue
    }
    const isMulti = item.isMultiDomain === true
    const defaultNames = Number(item.defaultSanCount)
    const maxNames = Number(item.maxSanCount)
    const row: SslProductRow = {
      product_code: code,
      name,
      vendor: text(item.vendorName, 80) ?? 'Unknown',
      validation_type: text(item.validationType, 20) ?? 'DV',
      is_wildcard: item.isWildcard === true,
      is_multi_domain: isMulti,
      // A single-name product covers its one name, whatever its SAN fields say.
      included_names:
        isMulti && Number.isInteger(defaultNames) && defaultNames >= 1
          ? Math.min(defaultNames, 250)
          : 1,
      max_names: Number.isInteger(maxNames) && maxNames >= 1 ? Math.min(maxNames, 1000) : 1,
      is_reissue_free: item.isReissueFree === true,
      requires_csr: item.requiresCsr !== false,
      create_usd: price,
    }
    byCode.set(code, [...(byCode.get(code) ?? []), row])
  }

  const rows: SslProductRow[] = []
  const ambiguous: string[] = []
  for (const [code, versions] of byCode) {
    const first = versions[0] as SslProductRow
    const same = versions.every((row) => JSON.stringify(row) === JSON.stringify(first))
    if (same) rows.push(first)
    else ambiguous.push(code)
  }
  rows.sort((a, b) => a.product_code.localeCompare(b.product_code))
  return { rows, ambiguous: ambiguous.sort(), unusable }
}

export type SslDiff = {
  added: SslProductRow[]
  /** Priced before, not listed now: unpriced, so withheld. */
  removed: string[]
  priceChanges: { code: string; name: string; fromUsd: number | null; toUsd: number }[]
  detailChanges: { code: string; fields: string[] }[]
}

export function compareSslProducts(rows: SslProductRow[], current: CurrentSslProduct[]): SslDiff {
  const now = new Map(current.map((row) => [row.product_code, row]))
  const listed = new Set(rows.map((row) => row.product_code))
  const diff: SslDiff = { added: [], removed: [], priceChanges: [], detailChanges: [] }
  for (const row of rows) {
    const before = now.get(row.product_code)
    // The owner's three are rows before the sync has priced them: "added" only if not there at all.
    if (!before) {
      diff.added.push(row)
      continue
    }
    if (before.create_usd === null || Number(before.create_usd) !== row.create_usd) {
      diff.priceChanges.push({
        code: row.product_code,
        name: row.name,
        fromUsd: before.create_usd === null ? null : Number(before.create_usd),
        toUsd: row.create_usd,
      })
    }
    const fields = (['name', 'is_wildcard', 'is_multi_domain', 'included_names'] as const).filter(
      (field) => before[field] !== row[field],
    )
    if (fields.length > 0) diff.detailChanges.push({ code: row.product_code, fields })
  }
  for (const row of current) {
    if (!listed.has(row.product_code) && row.create_usd !== null)
      diff.removed.push(row.product_code)
  }
  return diff
}

export function hasSslChanges(diff: SslDiff): boolean {
  return (
    diff.added.length + diff.removed.length + diff.priceChanges.length + diff.detailChanges.length >
    0
  )
}

/**
 * Why a listing cannot be trusted, or null. Nothing listed; more than half
 * the priced products gone; or a product we sell whose price moved more
 * than threefold either way — a unit or currency mistake, until someone
 * confirms it — or which stopped being the shape we sell it as.
 */
export function sslListingRefusal(
  parsed: ParsedListing,
  current: CurrentSslProduct[],
  diff: SslDiff,
): string | null {
  if (parsed.rows.length === 0) return 'The supplier listed no SSL products we could read'
  const priced = current.filter((row) => row.create_usd !== null)
  if (priced.length > 0 && diff.removed.length > priced.length / 2) {
    return `${diff.removed.length} of ${priced.length} priced SSL products are missing from the listing`
  }
  const sold = new Map(
    current.filter((row) => row.is_sellable).map((row) => [row.product_code, row]),
  )
  for (const change of diff.priceChanges) {
    if (!sold.has(change.code) || change.fromUsd === null) continue
    const ratio = change.toUsd / change.fromUsd
    if (ratio > 3 || ratio < 1 / 3) {
      return `${change.name} moved from $${change.fromUsd} to $${change.toUsd}: confirm it with the supplier first`
    }
  }
  for (const change of diff.detailChanges) {
    const before = sold.get(change.code)
    if (before?.create_usd !== null && before && change.fields.some((field) => field !== 'name')) {
      return `Product ${change.code}, which we sell, changed ${change.fields.join(', ')}: check it before selling it again`
    }
  }
  return null
}

export function formatSslReport(
  parsed: ParsedListing,
  diff: SslDiff,
  listed: number,
  current: CurrentSslProduct[],
): string[] {
  const sellable = new Set(current.filter((row) => row.is_sellable).map((row) => row.product_code))
  const mark = (code: string) => (sellable.has(code) ? ' [sold]' : '')
  const lines = [
    `SSL products listed: ${listed}; readable: ${parsed.rows.length}.`,
    `Added: ${diff.added.length}. Unpriced (no longer listed): ${diff.removed.length}. Price changes: ${diff.priceChanges.length}. Other changes: ${diff.detailChanges.length}.`,
  ]
  for (const row of diff.added) lines.push(`  + ${row.product_code} ${row.name} $${row.create_usd}`)
  for (const code of diff.removed) lines.push(`  - ${code}${mark(code)}`)
  for (const change of diff.priceChanges) {
    lines.push(
      `  $ ${change.code} ${change.name}${mark(change.code)}: ${change.fromUsd ?? 'unpriced'} → ${change.toUsd}`,
    )
  }
  for (const change of diff.detailChanges) {
    lines.push(`  ~ ${change.code}${mark(change.code)}: ${change.fields.join(', ')}`)
  }
  if (parsed.ambiguous.length > 0) {
    lines.push(`Listed more than once, differently — left alone: ${parsed.ambiguous.join(', ')}`)
  }
  if (parsed.unusable.length > 0) {
    lines.push(`Without a code, name or ${PRICE_GROUP} price: ${parsed.unusable.length}`)
  }
  return lines
}

// ── Reading and writing ──────────────────────────────────────────────────────

export type SslListing = { items: RawSslProduct[]; total: number | null }
export type SslListingSource = () => Promise<SslListing>

/** Far beyond the 35 listed; stops a supplier bug from paging forever. */
const MAX_PAGES = 10

export function createSslListingSource(options: {
  resellerId: string
  apiKey: string
  environment: 'ote' | 'production'
  pageSize?: number
  run?: <T>(task: () => Promise<T>) => Promise<T>
  getJson: typeof getJson
}): SslListingSource {
  const {
    resellerId,
    apiKey,
    environment,
    pageSize = 100,
    run = (task) => task(),
    getJson: get,
  } = options
  return async () => {
    const items: RawSslProduct[] = []
    let total: number | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${SSL_BASE_URL[environment]}/products/ssls?MaxResultCount=${pageSize}&SkipCount=${page * pageSize}`
      const answer = await run(() =>
        get(url, { 'X-API-KEY': apiKey, __reseller: resellerId }, 60_000),
      )
      const list = (answer as { items?: unknown } | null)?.items
      if (!Array.isArray(list)) throw new Error('The SSL product page was not a listing')
      const count = (answer as { totalCount?: unknown }).totalCount
      if (typeof count === 'number' && Number.isInteger(count)) total = count
      items.push(...(list as RawSslProduct[]))
      if (list.length < pageSize || (total !== null && items.length >= total))
        return { items, total }
    }
    throw new Error(`The SSL product listing ran past ${MAX_PAGES} pages; stopped reading`)
  }
}

export interface SslProductStore {
  load(): Promise<CurrentSslProduct[]>
  /** Writes the sync's columns; `is_sellable` is never sent, so the owner's choice stands. */
  upsert(rows: SslProductRow[], syncedAt: string): Promise<void>
  /** No longer listed: unpriced, so withheld (N5b). */
  unprice(codes: string[]): Promise<void>
}

export function createSslProductStore(client: SupabaseClient<Database>): SslProductStore {
  return {
    async load() {
      const { data, error } = await client
        .from('ssl_products')
        .select(
          'product_code, name, is_wildcard, is_multi_domain, included_names, create_usd, is_sellable',
        )
        .order('product_code')
      if (error) throw new Error(`Could not read the SSL products: ${error.message}`)
      return (data ?? []).map((row) => ({
        product_code: row.product_code,
        name: row.name ?? '',
        is_wildcard: row.is_wildcard ?? false,
        is_multi_domain: row.is_multi_domain ?? false,
        included_names: row.included_names ?? 1,
        create_usd: row.create_usd === null ? null : Number(row.create_usd),
        is_sellable: row.is_sellable,
      }))
    },
    async upsert(rows, syncedAt) {
      if (rows.length === 0) return
      const { error } = await client.from('ssl_products').upsert(
        rows.map((row) => ({ ...row, synced_at: syncedAt })),
        { onConflict: 'product_code' },
      )
      if (error) throw new Error(`Could not write the SSL products: ${error.message}`)
    },
    async unprice(codes) {
      if (codes.length === 0) return
      const { error } = await client
        .from('ssl_products')
        .update({ create_usd: null })
        .in('product_code', codes)
      if (error) throw new Error(`Could not unprice SSL products: ${error.message}`)
    },
  }
}

// ── One sync ─────────────────────────────────────────────────────────────────

export type SslSyncResult = {
  outcome: 'unchanged' | 'changes' | 'written' | 'refused'
  reason: string | null
  listed: number
  readable: number
  diff: SslDiff | null
  report: string[]
}

export async function syncSslProducts(options: {
  source: SslListingSource
  store: SslProductStore
  apply: boolean
  now?: () => Date
}): Promise<SslSyncResult> {
  const { source, store, apply, now = () => new Date() } = options
  const listing = await source()
  const parsed = toSslRows(listing.items)
  const counts = { listed: listing.items.length, readable: parsed.rows.length }
  if (listing.total !== null && listing.items.length < listing.total) {
    const reason = `Read ${listing.items.length} of ${listing.total} SSL products`
    return { outcome: 'refused', reason, ...counts, diff: null, report: [reason] }
  }
  const current = await store.load()
  const diff = compareSslProducts(parsed.rows, current)
  const report = formatSslReport(parsed, diff, counts.listed, current)
  const refusal = sslListingRefusal(parsed, current, diff)
  if (refusal) {
    return {
      outcome: 'refused',
      reason: refusal,
      ...counts,
      diff,
      report: [...report, '', `Refused: ${refusal}. Nothing written.`],
    }
  }
  if (!hasSslChanges(diff)) {
    return {
      outcome: 'unchanged',
      reason: null,
      ...counts,
      diff,
      report: [...report, '', 'SSL products are up to date.'],
    }
  }
  if (!apply) {
    return {
      outcome: 'changes',
      reason: null,
      ...counts,
      diff,
      report: [...report, '', 'Report only. Re-run with --apply to write.'],
    }
  }
  await store.upsert(parsed.rows, now().toISOString())
  await store.unprice(diff.removed)
  return { outcome: 'written', reason: null, ...counts, diff, report: [...report, '', 'Written.'] }
}

/** The counts a log line or heartbeat carries: no prices. */
export function summariseSsl(result: SslSyncResult) {
  return {
    listed: result.listed,
    sellable: result.readable,
    added: result.diff?.added.length ?? 0,
    retired: result.diff?.removed.length ?? 0,
    priceChanges: result.diff?.priceChanges.length ?? 0,
    otherChanges: result.diff?.detailChanges.length ?? 0,
  }
}
