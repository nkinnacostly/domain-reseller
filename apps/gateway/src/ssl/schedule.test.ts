import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env'
import { SSL_CATALOGUE_HEARTBEAT, sslCatalogueScheduleFor } from './schedule'

/** FR-SSL-1: the weekly SSL product sync runs only where the domain catalogue's does. */

const BASE = {
  GATEWAY_SHARED_SECRET: 'test-secret-value-at-least-16',
  DNA_RESELLER_ID: '00000000-0000-0000-0000-000000000000',
  DNA_API_KEY: 'x',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'x',
}
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('where the SSL product sync runs', () => {
  it.each([
    ['a laptop reading the live list', { NODE_ENV: 'development', DNA_ENV: 'production' }],
    ['a production gateway reading the sandbox', { NODE_ENV: 'production', DNA_ENV: 'ote' }],
  ])('never on %s', (_, over) => {
    expect(sslCatalogueScheduleFor(parseEnv({ ...BASE, ...over }), log())).toBeNull()
  })

  it('reads the live list, writes it, records its own heartbeat and refreshes the site', async () => {
    const writes: unknown[] = []
    const query = {
      select: () => query,
      eq: () => query,
      order: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      upsert: async (rows: unknown[]) => {
        writes.push(['upsert', rows.length])
        return { error: null }
      },
    }
    const client = {
      from: () => query,
      rpc: async (fn: string, args: { p_name: string }) => {
        writes.push([fn, args.p_name])
        return { data: null, error: null }
      },
    }
    const getJson = vi.fn(async () => ({
      totalCount: 1,
      items: [
        {
          name: 'Sectigo PositiveSSL Certificate',
          productCode: '351',
          isWildcard: false,
          isMultiDomain: false,
          prices: [
            { priceGroup: 'Reseller', create: [{ period: 1, price: 6.99, currency: 'USD' }] },
          ],
        },
      ],
    }))
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }))
    const created = sslCatalogueScheduleFor(
      parseEnv({
        ...BASE,
        NODE_ENV: 'production',
        DNA_ENV: 'production',
        APP_URL: 'https://www.mydomainshub.com',
      }),
      log(),
      { client: client as never, getJson: getJson as never, fetchImpl: fetchImpl as never },
    )
    await expect(created?.runOnce()).resolves.toMatchObject({
      status: 'done',
      result: { outcome: 'written' },
      pricesRefreshed: true,
    })
    expect(String((getJson.mock.calls[0] as unknown[] | undefined)?.[0])).toMatch(
      /^https:\/\/api\.domainresellerapi\.com\/api\/v1\/products\/ssls/,
    )
    expect(writes).toEqual([
      ['upsert', 1],
      ['record_heartbeat', SSL_CATALOGUE_HEARTBEAT],
    ])
  })
})
