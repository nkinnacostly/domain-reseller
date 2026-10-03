/**
 * The OTE proof behind RENEW_CHECK_ENABLED (ADMIN-SPEC §9, Package A
 * acceptance; v2 review point 8): `domains/renew/check` takes the same input
 * as Renew, so before the dashboard may call it we show, in the sandbox, that
 * it changes neither the balance, nor the domain's expiry, nor the ledger.
 *
 *   pnpm --filter @dr/gateway verify:renew-check                 # report
 *   pnpm --filter @dr/gateway verify:renew-check -- --record     # and write the fixture
 *
 * OTE only, with DNA_API_TEST_KEY: there is no flag for production. Each call
 * goes through createAdminSupplier's allowlist — reads, and the renew check —
 * one at a time, well inside the supplier's two a second.
 *
 * Exit: 0 nothing changed · 1 failed · 2 something changed
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { usdToCents } from '@dr/shared/admin'
import { createAdminSupplier } from '../src/admin/supplier'
import { supplierDay } from '../src/ledger/source'
import { loadRootEnv } from '../src/lib/env-file'

loadRootEnv()

const DOMAIN = process.env.RENEW_CHECK_DOMAIN ?? 'mydomainshubtest1.com'
const PERIOD = 1
const FIXTURE = fileURLToPath(new URL('./fixtures/renew-check-ote.json', import.meta.url))
const API_KEY = process.env.DNA_API_TEST_KEY ?? ''
const RESELLER_ID = process.env.DNA_RESELLER_ID ?? ''

if (!API_KEY || !RESELLER_ID) {
  console.error('DNA_API_TEST_KEY and DNA_RESELLER_ID must be set (the OTE sandbox only)')
  process.exit(1)
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const supplier = createAdminSupplier({
  environment: 'ote',
  apiKey: API_KEY,
  resellerId: RESELLER_ID,
  // One call at a time, 600 ms apart: under the account's two a second.
  run: async (task) => {
    await pause(600)
    return task()
  },
})
const LANE = { priority: 'low', waitMs: 30_000 } as const
const DAY_MS = 86_400_000

type Snapshot = { balanceCents: number; expiresAt: string; ledgerEntries: number }

function ok(status: number, what: string) {
  if (status < 200 || status >= 300) throw new Error(`${what} answered HTTP ${status}`)
}

async function snapshot(): Promise<Snapshot> {
  const account = await supplier.get('/deposit/accounts/me', {}, LANE)
  ok(account.status, 'deposit/accounts/me')
  const balance = (account.body as { usdBalance?: number | string }).usdBalance
  if (balance === undefined) throw new Error('No balance in deposit/accounts/me')

  const listing = await supplier.get('/domains', { DomainName: DOMAIN, MaxResultCount: 1 }, LANE)
  ok(listing.status, 'domains')
  const item = ((listing.body as { items?: unknown[] }).items ?? [])[0] as
    | { domainName?: string; expirationDate?: string }
    | undefined
  if (item?.domainName?.toLowerCase() !== DOMAIN || !item.expirationDate) {
    throw new Error(`${DOMAIN} is not in the OTE account`)
  }

  // Both dates, or the supplier ignores the start (§4.4); a wide window.
  const ledger = await supplier.get(
    '/deposit/transactions',
    {
      StartDate: supplierDay(Date.now() - 3650 * DAY_MS),
      EndDate: supplierDay(Date.now() + DAY_MS),
      MaxResultCount: 1,
    },
    LANE,
  )
  ok(ledger.status, 'deposit/transactions')
  const total = (ledger.body as { totalCount?: unknown }).totalCount
  if (typeof total !== 'number') throw new Error('No totalCount in deposit/transactions')

  return { balanceCents: usdToCents(balance), expiresAt: item.expirationDate, ledgerEntries: total }
}

async function main() {
  const before = await snapshot()
  const check = await supplier.postRead(
    '/domains/renew/check',
    { domainName: DOMAIN, period: PERIOD },
    LANE,
  )
  const answer = (check.body ?? {}) as {
    renewabilityStatus?: unknown
    renewalLock?: unknown
    errorMessageKey?: unknown
  }
  const after = await snapshot()
  const unchanged =
    before.balanceCents === after.balanceCents &&
    before.expiresAt === after.expiresAt &&
    before.ledgerEntries === after.ledgerEntries
  const record = {
    readAt: new Date().toISOString(),
    environment: 'ote',
    domain: DOMAIN,
    period: PERIOD,
    before,
    check: {
      status: check.status,
      renewable: answer.renewabilityStatus === true,
      renewalLock: answer.renewalLock === true,
      errorMessageKey: typeof answer.errorMessageKey === 'string' ? answer.errorMessageKey : null,
    },
    after,
    unchanged,
  }
  console.log(JSON.stringify(record, null, 2))
  if (process.argv.includes('--record')) {
    writeFileSync(FIXTURE, `${JSON.stringify(record, null, 2)}\n`)
    console.log(`Recorded in ${FIXTURE}`)
  }
  process.exit(unchanged ? 0 : 2)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The proof failed')
  process.exit(1)
})
