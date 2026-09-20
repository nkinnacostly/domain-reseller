/**
 * Catalogue sync — regenerates packages/shared/src/pricing/catalogue.json
 * from the live DomainNameAPI catalogue.
 *
 *   pnpm --filter @dr/gateway sync:catalogue            # report only
 *   pnpm --filter @dr/gateway sync:catalogue -- --write # write the snapshot
 *
 * Read-only against the supplier: it fetches the product catalogue and nothing
 * else. It never registers, renews or transfers.
 *
 * The diff is the point. Supplier prices move — Verisign raises .com on
 * 1 November 2026 — and between the change and our redeploy the storefront
 * quotes yesterday's price against today's cost. Run this on a schedule.
 *
 * Exit codes:  0 no changes · 1 fetch or write failed · 2 changes detected
 * (2 makes it usable as a scheduled check that opens a PR or pages someone.)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import {
  type CatalogueEntry,
  diffCatalogue,
  formatNaira,
  hasChanges,
  PLACEHOLDER_FX,
  retailImpact,
} from '@dr/shared'

// ── env ─────────────────────────────────────────────────────────────────────
const envPath = fileURLToPath(new URL('../../../.env', import.meta.url))
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
  const [key, ...rest] = trimmed.split('=')
  if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
}

const RESELLER_ID = process.env.DNA_RESELLER_ID ?? ''
const API_KEY = process.env.DNA_API_KEY ?? ''
const IS_PRODUCTION = process.env.DNA_ENV === 'production'
const WRITE = process.argv.includes('--write')

if (!RESELLER_ID || !API_KEY) {
  console.error('DNA_RESELLER_ID and DNA_API_KEY must be set in .env')
  process.exit(1)
}

const BASE = IS_PRODUCTION
  ? 'https://api.domainresellerapi.com/api/v1'
  : 'https://ote.domainresellerapi.com/api/v1'

const SNAPSHOT = fileURLToPath(
  new URL('../../../packages/shared/src/pricing/catalogue.json', import.meta.url),
)

// ── fetch ───────────────────────────────────────────────────────────────────
type PriceRow = { period?: number; price?: number }
type PriceGroup = Record<string, unknown>
type RawTld = {
  name: string
  minRegistrationPeriod?: number
  maxRegistrationPeriod?: number
  deletionRestorablePeriod?: number
  prices?: PriceGroup[]
  attributes?: unknown
}

/**
 * node:https rather than fetch: Node negotiates HTTP/2 with this host and
 * trips a TLS "bad record mac". axios and curl stay on HTTP/1.1 and are fine.
 */
function getJson(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      `${BASE}${path}`,
      {
        method: 'GET',
        headers: { 'X-API-KEY': API_KEY, __reseller: RESELLER_ID, Accept: 'application/json' },
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function priceOf(tld: RawTld, kind: string, period = 1): number | undefined {
  for (const group of tld.prices ?? []) {
    const rows = group[kind]
    if (!Array.isArray(rows)) continue
    for (const row of rows as PriceRow[]) if (row?.period === period) return row.price
  }
  return undefined
}

/**
 * Only a genuinely REQUIRED field counts as an eligibility restriction.
 * Optional acknowledgements — .app's SSL notice, for instance — must not be
 * presented as one, or we deter people from a TLD that needs nothing extra.
 */
function requiresExtraFields(tld: RawTld): boolean {
  const attrs = tld.attributes
  if (!Array.isArray(attrs)) return false
  return attrs.some(
    (a) =>
      typeof a === 'object' &&
      a !== null &&
      (a as { isRequired?: boolean }).isRequired === true &&
      (a as { type?: string }).type !== 'Label',
  )
}

function toEntry(tld: RawTld): CatalogueEntry | null {
  const register = priceOf(tld, 'register')
  if (typeof register !== 'number') return null // not sellable

  const entry: CatalogueEntry = {
    name: tld.name,
    register: Number(register.toFixed(2)),
    renew: Number((priceOf(tld, 'renew') ?? register).toFixed(2)),
    minPeriod: tld.minRegistrationPeriod ?? 1,
    maxPeriod: tld.maxRegistrationPeriod ?? 10,
    redemptionDays: tld.deletionRestorablePeriod ?? 0,
  }

  const transfer = priceOf(tld, 'transfer')
  if (typeof transfer === 'number' && transfer > 0) {
    entry.transfer = Number(transfer.toFixed(2))
  }
  if (requiresExtraFields(tld)) entry.requiresExtraFields = true

  return entry
}

async function fetchCatalogue(): Promise<CatalogueEntry[]> {
  const PAGE = 250
  const raw: RawTld[] = []
  let total = 0

  for (let skip = 0; ; skip += PAGE) {
    const page = (await getJson(`/products/tlds?MaxResultCount=${PAGE}&SkipCount=${skip}`)) as {
      totalCount?: number
      items?: RawTld[]
    }
    total = page.totalCount ?? total
    const items = page.items ?? []
    raw.push(...items)
    if (items.length < PAGE || raw.length >= total) break
  }

  console.log(`Fetched ${raw.length} TLDs from ${IS_PRODUCTION ? 'production' : 'OTE'}`)

  return raw
    .map(toEntry)
    .filter((e): e is CatalogueEntry => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// ── report ──────────────────────────────────────────────────────────────────
const rule = (title: string) => console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`)
const usd = (v: number | undefined) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—')

async function main() {
  const committed = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as CatalogueEntry[]
  const fetched = await fetchCatalogue()
  console.log(`${fetched.length} sellable · ${committed.length} in the committed snapshot`)

  const diff = diffCatalogue(committed, fetched)

  rule('Catalogue changes')
  if (!hasChanges(diff)) {
    console.log('None. The committed snapshot matches the live catalogue.')
  } else {
    console.log(
      `+${diff.added.length} added · -${diff.removed.length} removed · ` +
        `~${diff.changed.length} changed · ${diff.unchanged} unchanged`,
    )

    if (diff.added.length > 0) {
      console.log(`\nAdded:   ${diff.added.map((e) => `.${e.name}`).join(' ')}`)
    }
    if (diff.removed.length > 0) {
      console.log(`\nRemoved: ${diff.removed.map((e) => `.${e.name}`).join(' ')}`)
      console.log('         ⚠ Anything already sold on these still needs renewing.')
    }

    if (diff.changed.length > 0) {
      console.log('\nWholesale price changes:')
      console.log(
        `  ${'TLD'.padEnd(16)}${'field'.padEnd(10)}${'before'.padStart(9)}${'after'.padStart(9)}`,
      )
      for (const tld of diff.changed.slice(0, 40)) {
        for (const change of tld.changes) {
          console.log(
            `  .${tld.name.padEnd(15)}${change.field.padEnd(10)}` +
              `${usd(change.before).padStart(9)}${usd(change.after).padStart(9)}`,
          )
        }
      }
      if (diff.changed.length > 40) console.log(`  … and ${diff.changed.length - 40} more`)
    }
  }

  const impacts = retailImpact(committed, fetched, PLACEHOLDER_FX)
  rule(`Retail impact at ₦${PLACEHOLDER_FX.midRate} + ${PLACEHOLDER_FX.bufferPct}%`)

  if (impacts.length === 0) {
    console.log('No customer-visible price changes.')
  } else {
    const losing = impacts.filter((i) => i.sellingBelowCost)
    if (losing.length > 0) {
      console.log(`⚠ ${losing.length} price(s) no longer cover cost at what we are charging today.`)
      console.log('  Until this snapshot is regenerated AND deployed, those sales lose money.\n')
    }

    console.log(
      `  ${'TLD'.padEnd(16)}${'kind'.padEnd(14)}${'now'.padStart(10)}${'becomes'.padStart(10)}${'change'.padStart(10)}`,
    )
    for (const i of impacts.slice(0, 30)) {
      const flag = i.sellingBelowCost ? '  ⚠ below cost' : ''
      console.log(
        `  .${i.name.padEnd(15)}${i.kind.padEnd(14)}` +
          `${formatNaira(i.currentRetailNgn * 100).padStart(10)}` +
          `${formatNaira(i.newRetailNgn * 100).padStart(10)}` +
          `${`${i.deltaPct >= 0 ? '+' : ''}${i.deltaPct.toFixed(1)}%`.padStart(10)}${flag}`,
      )
    }
    if (impacts.length > 30) console.log(`  … and ${impacts.length - 30} more`)
  }

  rule('Snapshot')
  if (!hasChanges(diff)) {
    console.log('Nothing to write.')
    process.exit(0)
  }

  if (!WRITE) {
    console.log('Report only. Re-run with --write to update the snapshot, then')
    console.log('review the diff, run the tests, and deploy — prices change on deploy.')
    process.exit(2)
  }

  writeFileSync(SNAPSHOT, `${JSON.stringify(fetched)}\n`)
  console.log(`Written: ${SNAPSHOT}`)
  console.log('Now run the tests and deploy. The storefront keeps the old prices until you do.')
  process.exit(2)
}

main().catch((error) => {
  console.error('Sync failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
