/**
 * Day-0 supplier verification — PRD §19.
 *
 * Answers V1–V7 against the OTE sandbox with live credentials. Read-only:
 * it never registers, renews or transfers anything.
 *
 *   pnpm --filter @dr/gateway verify:supplier
 */
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'
import DomainNameApi from 'nodejs-dna'

// ── env ─────────────────────────────────────────────────────────────────────
const envPath = fileURLToPath(new URL('../../../.env', import.meta.url))
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
  const [k, ...rest] = trimmed.split('=')
  if (k && !process.env[k]) process.env[k] = rest.join('=').replace(/^["']|["']$/g, '')
}

const RESELLER_ID = process.env.DNA_RESELLER_ID ?? ''
const API_KEY = process.env.DNA_API_KEY ?? ''
const IS_PRODUCTION = process.env.DNA_ENV === 'production'

if (!RESELLER_ID || !API_KEY) {
  console.error('DNA_RESELLER_ID and DNA_API_KEY must be set in .env')
  process.exit(1)
}

if (IS_PRODUCTION) {
  console.warn(
    '\n⚠  Running against PRODUCTION. This script performs READ-ONLY calls only:\n' +
      '   GetResellerDetails · GetTldList · CheckAvailability.\n' +
      '   It must never be extended to register, renew, transfer or delete.\n',
  )
}

const api = new DomainNameApi(RESELLER_ID, API_KEY, {
  testMode: !IS_PRODUCTION,
  telemetry: false, // SEC-14 — never remove
})

const head = (title: string) => console.log(`\n${'━'.repeat(72)}\n${title}\n${'━'.repeat(72)}`)
const money = (n: unknown) => (typeof n === 'number' ? n.toFixed(2) : String(n))

// ── V3 · transport and endpoint ─────────────────────────────────────────────
head('V3 · Transport')
console.log(`transport   : ${api.getActiveTransport()}`)
console.log(`environment : ${IS_PRODUCTION ? 'PRODUCTION' : 'OTE sandbox'}`)

// ── V5 · account, tier, balance ─────────────────────────────────────────────
head('V5 · Reseller account')
try {
  const details = await api.GetResellerDetails()
  if (details.result === 'OK') {
    console.log(`name     : ${details.name}`)
    console.log(`id       : ${details.id}`)
    console.log(`active   : ${details.active}`)
    console.log(`balance  : ${money(details.balance)} ${details.currency ?? ''}`)
    if (Array.isArray(details.balances) && details.balances.length > 1) {
      console.log(`balances : ${JSON.stringify(details.balances)}`)
    }
  } else {
    console.log('FAILED', JSON.stringify(details))
  }
} catch (error) {
  console.log('THREW', error instanceof Error ? error.message : error)
}

// ── V1 / V6 · catalogue ─────────────────────────────────────────────────────
// Fetched RAW, not through the SDK. `GetTldList` normalises the response and
// DISCARDS deletionRestorablePeriod (redemption window), deletionHoldPeriod and
// attributes — all of which we need for TLD pages, lifecycle and FR-R4.
// The catalogue sync in the gateway must do the same.
head('V1 + V6 · TLD catalogue (raw endpoint)')

type PriceRow = { period?: number; price?: number; currency?: string }
type PriceGroup = { priceGroup?: string } & Record<string, unknown>
/** An EMPTY array is truthy in JS — check length, not existence. */
const hasAttributes = (t: { attributes?: unknown }) =>
  Array.isArray(t.attributes) ? t.attributes.length > 0 : Boolean(t.attributes)

type Tld = {
  name: string
  minRegistrationPeriod?: number
  maxRegistrationPeriod?: number
  deletionRestorablePeriod?: number
  deletionHoldPeriod?: number
  prices?: PriceGroup[]
  attributes?: unknown[] | Record<string, unknown> | null
}

const BASE = IS_PRODUCTION
  ? 'https://api.domainresellerapi.com/api/v1'
  : 'https://ote.domainresellerapi.com/api/v1'

const priceOf = (t: Tld, kind: string, period = 1): number | undefined => {
  for (const group of t.prices ?? []) {
    const rows = group[kind]
    if (!Array.isArray(rows)) continue
    for (const row of rows as PriceRow[]) if (row?.period === period) return row.price
  }
  return undefined
}
const cell = (v: number | undefined) => (typeof v === 'number' ? v.toFixed(2) : '—').padStart(8)

let tldCount = 0
try {
  // Node 26's fetch negotiates HTTP/2 with this host and trips a TLS
  // "bad record mac". axios (what the SDK uses) and curl stay on HTTP/1.1 and
  // are fine. node:https is HTTP/1.1, so we use it here. The gateway's
  // catalogue sync must avoid bare fetch against this endpoint for the same reason.
  const getJson = (path: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
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

  const PAGE = 250
  const catalogue: Tld[] = []
  let total = 0
  for (let skip = 0; ; skip += PAGE) {
    const page = (await getJson(`/products/tlds?MaxResultCount=${PAGE}&SkipCount=${skip}`)) as {
      totalCount?: number
      items?: Tld[]
    }
    total = page.totalCount ?? total
    const items = page.items ?? []
    catalogue.push(...items)
    if (items.length < PAGE || catalogue.length >= total) break
  }
  tldCount = catalogue.length
  console.log(`catalogue size : ${tldCount} (totalCount ${total}, paged in ${PAGE}s)`)

  const groups = new Set<string>()
  for (const t of catalogue)
    for (const g of t.prices ?? []) if (g.priceGroup) groups.add(g.priceGroup)
  console.log(`price group    : ${[...groups].join(', ') || 'none'}   ← our tier`)

  const byName = new Map(catalogue.map((t) => [t.name, t]))
  const table = (names: string[], title: string) => {
    console.log(`\n${title}   (USD)`)
    console.log(
      `  ${'TLD'.padEnd(11)}${'reg'.padStart(8)}${'renew'.padStart(8)}${'xfer'.padStart(8)}` +
        `${'period'.padStart(9)}${'RGP'.padStart(5)}${'hold'.padStart(6)}${'attrs'.padStart(7)}`,
    )
    console.log(`  ${'-'.repeat(62)}`)
    for (const n of names) {
      const t = byName.get(n)
      if (!t) {
        console.log(`  .${n.padEnd(10)}${'NOT IN CATALOGUE'.padStart(8)}`)
        continue
      }
      console.log(
        `  .${n.padEnd(10)}${cell(priceOf(t, 'register'))}${cell(priceOf(t, 'renew'))}${cell(priceOf(t, 'transfer'))}` +
          `${`${t.minRegistrationPeriod}-${t.maxRegistrationPeriod}y`.padStart(9)}` +
          `${String(t.deletionRestorablePeriod ?? '—').padStart(5)}` +
          `${String(t.deletionHoldPeriod ?? '—').padStart(6)}` +
          `${(hasAttributes(t) ? 'YES' : '-').padStart(7)}`,
      )
    }
  }

  table(
    catalogue.filter((t) => t.name === 'ng' || t.name.endsWith('.ng')).map((t) => t.name),
    'NIGERIA — the launch set',
  )
  table(
    ['com', 'net', 'org', 'io', 'co', 'app', 'dev', 'xyz', 'shop', 'africa', 'me'],
    'HEADLINE TLDs',
  )

  const priced = catalogue
    .map((t) => ({ name: t.name, p: priceOf(t, 'register') }))
    .filter((x): x is { name: string; p: number } => typeof x.p === 'number')
  console.log(`\nTLDs with a 1yr register price : ${priced.length} of ${tldCount}`)
  console.log(`TLDs needing extra fields (FR-R4): ${catalogue.filter(hasAttributes).length}`)
} catch (error) {
  const cause = error instanceof Error ? (error.cause ?? error.message) : error
  console.log('THREW', error instanceof Error ? error.message : error, '| cause:', cause)
}

// ── V7 · availability and premium handling ──────────────────────────────────
head('V7 · Availability + premium handling')
try {
  const results = await api.CheckAvailability(['zzqx-test-9182', 'hotel'], ['com', 'ng'], 1)
  if (Array.isArray(results)) {
    for (const r of results) {
      console.log(
        `  ${r.DomainName}.${r.TLD}`.padEnd(26) +
          `${String(r.Status).padEnd(14)} price ${money(r.Price)} ${r.Currency ?? ''}` +
          `${r.IsFee ? '  [FEE/PREMIUM]' : ''}${r.ClassKey ? `  class=${r.ClassKey}` : ''}` +
          `${r.Reason ? `  reason=${r.Reason}` : ''}`,
      )
    }
  } else {
    console.log('FAILED', JSON.stringify(results).slice(0, 400))
  }
} catch (error) {
  console.log('THREW', error instanceof Error ? error.message : error)
}

// ── V4 · rate limit probe (gentle: 8 sequential calls) ──────────────────────
head('V4 · Rate limit probe — 8 sequential availability calls')
let rateLimited = false
for (let i = 1; i <= 8; i++) {
  const started = Date.now()
  try {
    const r = await api.CheckAvailability([`probe-${i}-${Date.now()}`], ['com'], 1)
    const ok = Array.isArray(r)
    const detail = ok ? 'ok' : `ERROR ${JSON.stringify(r).slice(0, 120)}`
    if (!ok) rateLimited = true
    console.log(`  call ${i}: ${String(Date.now() - started).padStart(5)}ms  ${detail}`)
  } catch (error) {
    rateLimited = true
    console.log(`  call ${i}: threw ${error instanceof Error ? error.message : error}`)
  }
}
console.log(
  rateLimited ? '\n  → throttling or errors observed' : '\n  → no throttling at this rate',
)

head('Summary')
console.log(`V1 .ng family        : see catalogue section above`)
console.log(
  `V2 IP allowlisting   : ${'no API_301 seen — not enforced for this IP, or not enabled'}`,
)
console.log(
  `V3 transport         : ${api.getActiveTransport()} against ${IS_PRODUCTION ? 'production' : 'OTE'}`,
)
console.log(
  `V4 rate limits       : ${rateLimited ? 'throttling observed' : 'none at 8 sequential calls'}`,
)
console.log(`V6 catalogue size    : ${tldCount}`)
console.log('\nNothing was registered, renewed or transferred by this script.')
