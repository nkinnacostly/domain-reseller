import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { server } from '../../../../../tests/mocks/server'

/**
 * adminDb against the hosted project's test side (ADMIN-SPEC §2.3, §8.1),
 * opt-in like the gateway's DB tests:
 *
 *   DB_TESTS=1 pnpm --filter @dr/web exec vitest run src/features/admin/__tests__/foundation/session.db.test.ts
 *
 * The unit tests prove the builder is asked for the right filter; only
 * PostgREST can say the embedded side filters (`admin_side.test_mode`,
 * `admin_side.orders.test_mode`) are real. Each read is a count with
 * `limit(0)`, so no row leaves the database. A table from migration 41 that is not applied yet
 * is reported and skipped, not failed.
 */

const ROOT_ENV = join(__dirname, '../../../../../../../.env')
const MISSING = new Set(['PGRST205', '42P01'])

type Read = { error: { code?: string; message: string } | null; count: number | null }

describe.skipIf(process.env.DB_TESTS !== '1')('adminDb on the hosted test side', () => {
  // biome-ignore lint/suspicious/noExplicitAny: the modules are imported after the env is set
  let session: any
  // biome-ignore lint/suspicious/noExplicitAny: as above
  let fixtures: any

  beforeAll(async () => {
    // The real network, with the real keys: MSW and the test env stand aside.
    server.close()
    for (const line of readFileSync(ROOT_ENV, 'utf8').split('\n')) {
      const match = /^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SECRET_KEY)=(.*)$/.exec(line.trim())
      if (match?.[1] && match[2]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
    session = await import('@/features/admin/queries/session')
    fixtures = await import('./fixtures')
  })
  afterAll(() => server.listen({ onUnhandledRequest: 'error' }))

  async function principal() {
    const client = fixtures.sessionClient({
      rpc: { admin_whoami: { data: fixtures.whoami({ testOnly: true }) } },
    }).client
    return session.adminWhoami(client, null)
  }

  it.each([
    ['order_items', 'id, orders(order_number)'],
    ['refund_events', 'id, refunds(status)'],
    ['order_item_costs', 'order_item_id, order_items(item_type)'],
    ['domain_events', 'id, domains(domain_name)'],
    ['admin_orders_v', 'id, order_number'],
  ])('reads %s with its side filter', async (table, columns) => {
    const db = session.adminDb(await principal(), 'test')
    const read: Read = await db.from(table).select(columns, { count: 'exact' }).limit(0)
    if (read.error && MISSING.has(read.error.code ?? '')) {
      console.warn(`${table}: not on this database yet (migrations 40–41)`)
      return
    }
    expect(read.error, `${table}: ${read.error?.message}`).toBeNull()
    expect(typeof read.count).toBe('number')
  })
})
