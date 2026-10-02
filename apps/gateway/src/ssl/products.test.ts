import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSslSupplier } from '../test-support/ssl-supplier'
import {
  type CurrentSslProduct,
  compareSslProducts,
  createSslListingSource,
  createSslProductStore,
  formatSslReport,
  type RawSslProduct,
  type SslProductStore,
  sslListingRefusal,
  summariseSsl,
  syncSslProducts,
  toSslRows,
} from './products'

/** FR-SSL-1, N5b: the SSL product list, reported before written, refused when it cannot be trusted. */

const price = (usd: number, group = 'Reseller') => [
  { priceGroup: group, create: [{ period: 1, price: usd, currency: 'USD' }] },
]

const raw = (
  code: string,
  name: string,
  usd: number,
  over: Partial<RawSslProduct> = {},
): RawSslProduct => ({
  productCode: code,
  name,
  vendorName: 'Sectigo',
  validationType: 'DV',
  isWildcard: false,
  isMultiDomain: false,
  defaultSanCount: 1,
  maxSanCount: 1,
  isReissueFree: true,
  requiresCsr: true,
  prices: price(usd),
  ...over,
})

/** The live listing's shape for the owner's three, as read on 2 Oct 2026. */
const LISTING = [
  raw('351', 'Sectigo PositiveSSL Certificate', 6.99),
  raw('352', 'Sectigo PositiveSSL Wildcard', 87.99, { isWildcard: true, maxSanCount: 100 }),
  raw('371', 'Sectigo PositiveSSL Multi Domain Certificate', 36.99, {
    isMultiDomain: true,
    defaultSanCount: 4,
    maxSanCount: 100,
  }),
  // Listed twice, differently — as the live list does.
  raw('412', 'Comodo Multi Domain Wildcard SSL', 213.9),
  raw('412', 'Comodo Multi Domain SSL + Wildcard (FLEX)', 47.99),
  // Listed twice, the same.
  raw('503', 'GeoTrust QuickSSL Premium Certificate (FLEX)', 64.9),
  raw('503', 'GeoTrust QuickSSL Premium Certificate (FLEX)', 64.9),
]

/** The three as migration 39 seeds them: for sale, not yet priced. */
const SEEDED: CurrentSslProduct[] = ['351', '352', '371'].map((code) => ({
  product_code: code,
  name: '',
  is_wildcard: false,
  is_multi_domain: false,
  included_names: 1,
  create_usd: null,
  is_sellable: true,
}))

describe('reading the SSL product list', () => {
  it('takes the Reseller group’s one-period price, and the names each covers', () => {
    const { rows, ambiguous, unusable } = toSslRows(LISTING)
    expect(
      rows.map((row) => [row.product_code, row.create_usd, row.included_names, row.is_wildcard]),
    ).toEqual([
      ['351', 6.99, 1, false],
      ['352', 87.99, 1, true],
      ['371', 36.99, 4, false],
      ['503', 64.9, 1, false],
    ])
    expect(ambiguous).toEqual(['412'])
    expect(unusable).toEqual([])
  })

  it('leaves out a product with no code, no name, or no Reseller price', () => {
    const { rows, unusable } = toSslRows([
      raw('', 'No code', 5),
      raw('900', '', 5),
      raw('901', 'Premium only', 5, { prices: price(5, 'Premium') }),
      raw('902', 'Two years only', 5, {
        prices: [{ priceGroup: 'Reseller', create: [{ period: 2, price: 9, currency: 'USD' }] }],
      }),
      raw('903', 'Free', 0),
      raw('9-04', 'Bad code', 5),
      raw('905', 'Not an array', 5, { prices: 'x' }),
    ])
    expect(rows).toEqual([])
    expect(unusable).toHaveLength(7)
  })
})

describe('comparing it with what we hold', () => {
  it('prices the owner’s seeded three on the first run, without calling them new', () => {
    const { rows } = toSslRows(LISTING)
    const diff = compareSslProducts(rows, SEEDED)
    expect(diff.added.map((row) => row.product_code)).toEqual(['503'])
    expect(diff.priceChanges.map((change) => [change.code, change.fromUsd, change.toUsd])).toEqual([
      ['351', null, 6.99],
      ['352', null, 87.99],
      ['371', null, 36.99],
    ])
    expect(sslListingRefusal(toSslRows(LISTING), SEEDED, diff)).toBeNull()
  })

  it('unprices a product no longer listed, so it is withheld', () => {
    const current = [
      { ...SEEDED[0], create_usd: 6.99, name: 'Sectigo PositiveSSL Certificate' },
    ] as CurrentSslProduct[]
    const diff = compareSslProducts([], current)
    expect(diff.removed).toEqual(['351'])
  })

  it('refuses a listing that is empty, or lost half its priced products', () => {
    const priced = SEEDED.map((row) => ({ ...row, create_usd: 10 }))
    expect(
      sslListingRefusal(
        { rows: [], ambiguous: [], unusable: [] },
        priced,
        compareSslProducts([], priced),
      ),
    ).toMatch(/no SSL products/)
    const one = toSslRows([raw('351', 'Sectigo PositiveSSL Certificate', 10)])
    expect(sslListingRefusal(one, priced, compareSslProducts(one.rows, priced))).toMatch(
      /2 of 3 priced SSL products are missing/,
    )
  })

  it('refuses a price we sell at that moved threefold, until someone confirms it', () => {
    const current: CurrentSslProduct[] = [
      {
        ...(SEEDED[0] as CurrentSslProduct),
        name: 'Sectigo PositiveSSL Certificate',
        create_usd: 6.99,
      },
    ]
    const jump = toSslRows([raw('351', 'Sectigo PositiveSSL Certificate', 69.9)])
    expect(sslListingRefusal(jump, current, compareSslProducts(jump.rows, current))).toMatch(
      /moved from \$6.99 to \$69.9/,
    )
    const drop = toSslRows([raw('351', 'Sectigo PositiveSSL Certificate', 0.99)])
    expect(sslListingRefusal(drop, current, compareSslProducts(drop.rows, current))).toMatch(
      /confirm it/,
    )
    const fine = toSslRows([raw('351', 'Sectigo PositiveSSL Certificate', 7.49)])
    expect(sslListingRefusal(fine, current, compareSslProducts(fine.rows, current))).toBeNull()
  })

  it('refuses a product we sell that changed shape, but not one that was renamed', () => {
    const current: CurrentSslProduct[] = [
      { ...(SEEDED[0] as CurrentSslProduct), name: 'Old name', create_usd: 6.99 },
    ]
    const renamed = toSslRows([raw('351', 'New name', 6.99)])
    expect(
      sslListingRefusal(renamed, current, compareSslProducts(renamed.rows, current)),
    ).toBeNull()
    const wild = toSslRows([raw('351', 'Old name', 6.99, { isWildcard: true })])
    expect(sslListingRefusal(wild, current, compareSslProducts(wild.rows, current))).toMatch(
      /changed is_wildcard/,
    )
  })

  it('reports every change, marking what we sell', () => {
    const parsed = toSslRows(LISTING)
    const report = formatSslReport(
      parsed,
      compareSslProducts(parsed.rows, SEEDED),
      LISTING.length,
      SEEDED,
    )
    expect(report[0]).toBe('SSL products listed: 7; readable: 4.')
    expect(report).toContain('  $ 351 Sectigo PositiveSSL Certificate [sold]: unpriced → 6.99')
    expect(report).toContain('  + 503 GeoTrust QuickSSL Premium Certificate (FLEX) $64.9')
    expect(report.at(-1)).toBe('Listed more than once, differently — left alone: 412')
  })
})

function memoryStore(
  current: CurrentSslProduct[],
): SslProductStore & { upsert: ReturnType<typeof vi.fn>; unprice: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async () => current),
    upsert: vi.fn(async () => {}),
    unprice: vi.fn(async () => {}),
  } as never
}

describe('one SSL product sync', () => {
  const source =
    (items: RawSslProduct[], total: number | null = items.length) =>
    async () => ({ items, total })

  it('reports and writes nothing unless asked to apply', async () => {
    const store = memoryStore(SEEDED)
    const result = await syncSslProducts({ source: source(LISTING), store, apply: false })
    expect(result.outcome).toBe('changes')
    expect(store.upsert).not.toHaveBeenCalled()
    expect(result.report.at(-1)).toBe('Report only. Re-run with --apply to write.')
  })

  it('writes the sync’s columns — never is_sellable — and unprices what left', async () => {
    const store = memoryStore([
      ...SEEDED,
      {
        product_code: '503',
        name: 'GeoTrust QuickSSL Premium Certificate (FLEX)',
        is_wildcard: false,
        is_multi_domain: false,
        included_names: 1,
        create_usd: 64.9,
        is_sellable: false,
      },
      {
        ...(SEEDED[0] as CurrentSslProduct),
        product_code: '999',
        create_usd: 5,
        is_sellable: false,
      },
    ])
    const result = await syncSslProducts({
      source: source(LISTING),
      store,
      apply: true,
      now: () => new Date('2026-10-02T12:00:00Z'),
    })
    expect(result.outcome).toBe('written')
    const [rows, at] = store.upsert.mock.calls[0] ?? []
    expect(at).toBe('2026-10-02T12:00:00.000Z')
    expect((rows as object[]).every((row) => !('is_sellable' in row))).toBe(true)
    expect(store.unprice).toHaveBeenCalledWith(['999'])
    expect(summariseSsl(result)).toEqual({
      listed: 7,
      sellable: 4,
      added: 0,
      retired: 1,
      priceChanges: 3,
      otherChanges: 3,
    })
  })

  it('says when nothing changed, and refuses a short read', async () => {
    const priced: CurrentSslProduct[] = toSslRows(LISTING).rows.map((row) => ({
      ...row,
      is_sellable: false,
    }))
    await expect(
      syncSslProducts({ source: source(LISTING), store: memoryStore(priced), apply: true }),
    ).resolves.toMatchObject({ outcome: 'unchanged' })
    await expect(
      syncSslProducts({ source: source(LISTING, 50), store: memoryStore(priced), apply: true }),
    ).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'Read 7 of 50 SSL products',
    })
    const refused = await syncSslProducts({
      source: source([]),
      store: memoryStore(priced),
      apply: true,
    })
    expect(refused.outcome).toBe('refused')
    expect(summariseSsl({ ...refused, diff: null })).toMatchObject({ added: 0, retired: 0 })
  })
})

describe('reading the list from the supplier', () => {
  const supplier = createSslSupplier()
  const server = setupServer(...supplier.handlers)
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterAll(() => server.close())

  it('pages through the listing with our credentials, inside the slot it is given', async () => {
    const get = vi.fn(async (url: string, headers?: Record<string, string>) => {
      const response = await fetch(url, { headers: headers ?? {} })
      return response.json()
    })
    const run = vi.fn(<T>(task: () => Promise<T>) => task())
    const read = createSslListingSource({
      resellerId: 'r',
      apiKey: 'k',
      environment: 'ote',
      pageSize: 100,
      run: run as never,
      getJson: get as never,
    })
    const listing = await read()
    expect(listing.total).toBe(2)
    expect(listing.items.map((item) => item.productCode)).toEqual(['351', '352'])
    expect(get.mock.calls[0]?.[0]).toBe(
      'https://ote.domainresellerapi.com/api/v1/products/ssls?MaxResultCount=100&SkipCount=0',
    )
    expect(get.mock.calls[0]?.[1]).toEqual({ 'X-API-KEY': 'k', __reseller: 'r' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stops at a page that is not a listing, and at one that never ends', async () => {
    await expect(
      createSslListingSource({
        resellerId: 'r',
        apiKey: 'k',
        environment: 'production',
        getJson: (async () => ({ nope: 1 })) as never,
      })(),
    ).rejects.toThrow('not a listing')
    const endless = vi.fn(async () => ({ items: [{}, {}] }))
    await expect(
      createSslListingSource({
        resellerId: 'r',
        apiKey: 'k',
        environment: 'production',
        pageSize: 2,
        getJson: endless as never,
      })(),
    ).rejects.toThrow('ran past 10 pages')
  })
})

describe('the SSL product store', () => {
  function fakeClient(answer: { data?: unknown; error?: { message: string } | null } = {}) {
    const calls: unknown[] = []
    const result = { data: answer.data ?? null, error: answer.error ?? null }
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'order', 'update', 'in']) {
      chain[method] = (...args: unknown[]) => {
        calls.push([method, ...args])
        return Object.assign(Promise.resolve(result), chain)
      }
    }
    chain.upsert = (...args: unknown[]) => {
      calls.push(['upsert', ...args])
      return Promise.resolve(result)
    }
    return {
      client: {
        from: (table: string) => {
          calls.push(['from', table])
          return chain
        },
      } as never,
      calls,
    }
  }

  it('reads the products, defaulting what the seed left empty', async () => {
    const { client } = fakeClient({
      data: [
        {
          product_code: '351',
          name: null,
          is_wildcard: null,
          is_multi_domain: null,
          included_names: null,
          create_usd: '6.99',
          is_sellable: true,
        },
      ],
    })
    await expect(createSslProductStore(client).load()).resolves.toEqual([
      {
        product_code: '351',
        name: '',
        is_wildcard: false,
        is_multi_domain: false,
        included_names: 1,
        create_usd: 6.99,
        is_sellable: true,
      },
    ])
  })

  it('upserts by code with the sync time, and unprices by code', async () => {
    const { client, calls } = fakeClient()
    const store = createSslProductStore(client)
    await store.upsert(toSslRows(LISTING).rows.slice(0, 1), 'now')
    await store.unprice(['999'])
    await store.upsert([], 'now')
    await store.unprice([])
    expect(calls).toContainEqual([
      'upsert',
      [expect.objectContaining({ product_code: '351', synced_at: 'now' })],
      { onConflict: 'product_code' },
    ])
    expect(calls).toContainEqual(['update', { create_usd: null }])
    expect(calls).toContainEqual(['in', 'product_code', ['999']])
  })

  it('passes a failed read or write on', async () => {
    const { client } = fakeClient({ error: { message: 'boom' } })
    const store = createSslProductStore(client)
    await expect(store.load()).rejects.toThrow('Could not read the SSL products: boom')
    await expect(store.upsert(toSslRows(LISTING).rows, 'now')).rejects.toThrow('Could not write')
    await expect(store.unprice(['1'])).rejects.toThrow('Could not unprice')
  })
})
