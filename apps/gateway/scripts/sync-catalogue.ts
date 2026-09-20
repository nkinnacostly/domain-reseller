/**
 * Catalogue sync — pulls wholesale costs from the reseller platform into the
 * `tlds` table. The storefront prices from that table, so this is the only
 * source of cost data.
 *
 *   pnpm --filter @dr/gateway sync:catalogue            # report
 *   pnpm --filter @dr/gateway sync:catalogue -- --apply # and write
 *
 * Read-only against the supplier: it fetches the product catalogue and nothing
 * else. It never registers, renews or transfers.
 *
 * Exit: 0 no changes · 1 failed · 2 changes detected
 */
import { createServiceClient } from '../src/lib/db'
import { loadRootEnv } from '../src/lib/env-file'
import { getJson } from '../src/lib/http'

loadRootEnv()

const APPLY = process.argv.includes('--apply')
const RESELLER_ID = process.env.DNA_RESELLER_ID ?? ''
const API_KEY = process.env.DNA_API_KEY ?? ''
const BASE =
  process.env.DNA_ENV === 'production'
    ? 'https://api.domainresellerapi.com/api/v1'
    : 'https://ote.domainresellerapi.com/api/v1'

if (!RESELLER_ID || !API_KEY) {
  console.error('DNA_RESELLER_ID and DNA_API_KEY must be set')
  process.exit(1)
}

const db = createServiceClient()

type PriceRow = { period?: number; price?: number }
type RawTld = {
  name: string
  minRegistrationPeriod?: number
  maxRegistrationPeriod?: number
  deletionRestorablePeriod?: number
  prices?: Record<string, unknown>[]
  attributes?: unknown
}

type TldRow = {
  name: string
  register_usd: number
  renew_usd: number
  transfer_usd: number | null
  restore_usd: number | null
  min_period: number
  max_period: number
  redemption_days: number
  requires_extra_fields: boolean
  is_sellable: boolean
}

function priceOf(tld: RawTld, kind: string, period = 1): number | null {
  for (const group of tld.prices ?? []) {
    const rows = group[kind]
    if (!Array.isArray(rows)) continue
    for (const row of rows as PriceRow[]) {
      if (row?.period === period && typeof row.price === 'number') return row.price
    }
  }
  return null
}

/**
 * Only a genuinely REQUIRED field is an eligibility restriction. Optional
 * acknowledgements — .app's SSL notice, say — must not be shown as one, or we
 * deter people from a TLD that needs nothing extra.
 */
function requiresExtraFields(tld: RawTld): boolean {
  if (!Array.isArray(tld.attributes)) return false
  return tld.attributes.some(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      (a as { isRequired?: boolean }).isRequired === true &&
      (a as { type?: string }).type !== 'Label',
  )
}

function toRow(tld: RawTld): TldRow | null {
  const register = priceOf(tld, 'register')
  if (register === null || register <= 0) return null

  return {
    name: tld.name,
    register_usd: register,
    renew_usd: priceOf(tld, 'renew') ?? register,
    transfer_usd: priceOf(tld, 'transfer'),
    restore_usd: priceOf(tld, 'restore'),
    min_period: tld.minRegistrationPeriod ?? 1,
    max_period: tld.maxRegistrationPeriod ?? 10,
    redemption_days: tld.deletionRestorablePeriod ?? 0,
    requires_extra_fields: requiresExtraFields(tld),
    is_sellable: true,
  }
}

async function fetchCatalogue(): Promise<TldRow[]> {
  const PAGE = 250
  const raw: RawTld[] = []
  let total = 0

  for (let skip = 0; ; skip += PAGE) {
    const page = (await getJson(
      `${BASE}/products/tlds?MaxResultCount=${PAGE}&SkipCount=${skip}`,
      { 'X-API-KEY': API_KEY, __reseller: RESELLER_ID },
      60_000,
    )) as { totalCount?: number; items?: RawTld[] }

    total = page.totalCount ?? total
    const items = page.items ?? []
    raw.push(...items)
    if (items.length < PAGE || raw.length >= total) break
  }

  console.log(`Fetched ${raw.length} extensions from the reseller platform`)
  return raw
    .map(toRow)
    .filter((r): r is TldRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

const usd = (v: number | null) => (v === null ? '—' : `$${v.toFixed(2)}`)

async function main() {
  const fetched = await fetchCatalogue()
  console.log(`${fetched.length} sellable`)

  const { data: existing, error } = await db
    .from('tlds')
    .select('name, register_usd, renew_usd, transfer_usd, restore_usd')

  if (error) {
    console.error(`Could not read the current catalogue: ${error.message}`)
    process.exit(1)
  }

  const before = new Map((existing ?? []).map((r) => [r.name as string, r]))
  const fetchedNames = new Set(fetched.map((r) => r.name))

  const added = fetched.filter((r) => !before.has(r.name))
  const removed = [...before.keys()].filter((name) => !fetchedNames.has(name))
  const changed = fetched.filter((r) => {
    const prev = before.get(r.name)
    if (!prev) return false
    return (
      Number(prev.register_usd) !== r.register_usd ||
      Number(prev.renew_usd) !== r.renew_usd ||
      (prev.transfer_usd === null ? null : Number(prev.transfer_usd)) !== r.transfer_usd ||
      (prev.restore_usd === null ? null : Number(prev.restore_usd)) !== r.restore_usd
    )
  })

  console.log(
    `\n+${added.length} added · -${removed.length} removed · ~${changed.length} changed · ` +
      `${fetched.length - added.length - changed.length} unchanged`,
  )

  if (added.length > 0) console.log(`\nAdded:   ${added.map((r) => `.${r.name}`).join(' ')}`)
  if (removed.length > 0) {
    console.log(`\nRemoved: ${removed.map((n) => `.${n}`).join(' ')}`)
    console.log('         Marked unsellable — anything already sold still needs renewing.')
  }

  if (changed.length > 0) {
    console.log('\nWholesale changes:')
    for (const row of changed.slice(0, 30)) {
      const prev = before.get(row.name)
      console.log(
        `  .${row.name.padEnd(16)}` +
          `register ${usd(prev ? Number(prev.register_usd) : null)} → ${usd(row.register_usd)}` +
          `   renew ${usd(prev ? Number(prev.renew_usd) : null)} → ${usd(row.renew_usd)}`,
      )
    }
    if (changed.length > 30) console.log(`  … and ${changed.length - 30} more`)
  }

  const hasChanges = added.length > 0 || removed.length > 0 || changed.length > 0
  if (!hasChanges) {
    console.log('\nCatalogue is up to date.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply to write.')
    process.exit(2)
  }

  // Upsert in batches; Postgres rejects very large single statements.
  const BATCH = 200
  for (let i = 0; i < fetched.length; i += BATCH) {
    const batch = fetched
      .slice(i, i + BATCH)
      .map((r) => ({ ...r, synced_at: new Date().toISOString() }))
    const { error: upsertError } = await db.from('tlds').upsert(batch, { onConflict: 'name' })
    if (upsertError) {
      console.error(`\nUpsert failed at row ${i}: ${upsertError.message}`)
      process.exit(1)
    }
  }

  // Extensions the supplier dropped stay in the table but stop being sold.
  if (removed.length > 0) {
    const { error: retireError } = await db
      .from('tlds')
      .update({ is_sellable: false })
      .in('name', removed)
    if (retireError) {
      console.error(`\nCould not retire removed extensions: ${retireError.message}`)
      process.exit(1)
    }
  }

  console.log(`\nWritten. ${fetched.length} extensions now priced from the live catalogue.`)
  process.exit(2)
}

main().catch((error) => {
  console.error('Sync failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
