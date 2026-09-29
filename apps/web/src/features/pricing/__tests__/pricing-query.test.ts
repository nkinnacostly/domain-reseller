import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const { createServiceClient } = await import('@/lib/supabase/service')
const { logger } = await import('@/lib/logger')
const { getPricedCatalogue, loadPricedCatalogue, PricingReadError, readPricedCatalogue } =
  await import('../queries/pricing')

type Result = { data: unknown; error: { message: string } | null }

const RATE = {
  id: 'rate-1',
  costing_rate: 1500,
  buffer_pct: 0,
  source: 'test',
  effective_from: '2026-09-01T00:00:00Z',
}
const SETTINGS = { margin_ngn: 3000, icann_fee_usd: 0.2, vat_pct: 7.5 }
const TLDS = [
  {
    name: 'com',
    register_usd: 10,
    renew_usd: 11,
    transfer_usd: 10,
    restore_usd: 80,
    min_period: 1,
    max_period: 10,
    redemption_days: 30,
    requires_extra_fields: false,
    is_country_code: false,
    featured_rank: 1,
    featured_tagline: 'The one everybody types first',
  },
]

const ok = (data: unknown): Result => ({ data, error: null })
const dropped: Result = { data: null, error: { message: 'TypeError: fetch failed' } }

/**
 * A stand-in for the Supabase query builder: every chained call returns the
 * same promise, which resolves to the table's result.
 */
function client(results: Record<'fx_rates' | 'pricing_settings' | 'tlds', Result>) {
  const from = vi.fn((table: keyof typeof results) => {
    const query = Object.assign(Promise.resolve(results[table]), {
      select: () => query,
      eq: () => query,
      order: () => query,
      range: () => query,
      maybeSingle: () => query,
    })
    return query
  })
  return { from }
}

const healthy = () => client({ fx_rates: ok(RATE), pricing_settings: ok(SETTINGS), tlds: ok(TLDS) })

beforeEach(() => vi.clearAllMocks())

describe('loadPricedCatalogue (the cached read)', () => {
  it('prices the catalogue when every query answers', async () => {
    vi.mocked(createServiceClient).mockReturnValue(healthy() as never)
    const priced = await loadPricedCatalogue()
    expect(priced?.tlds.map((t) => t.tld)).toEqual(['com'])
    expect(priced?.featured[0]?.tagline).toBe('The one everybody types first')
  })

  it('reads a row without period columns (before migration 37) as every year, as before', async () => {
    vi.mocked(createServiceClient).mockReturnValue(healthy() as never)
    const [com] = (await loadPricedCatalogue())?.tlds ?? []
    expect(com).toMatchObject({
      registerPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      renewPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      firstTerm: { years: 1 },
      renewalTerm: { years: 1 },
    })
  })

  it('prices a block-sold extension from the periods its row lists (.ai)', async () => {
    const ai = {
      ...TLDS[0],
      name: 'ai',
      register_usd: '99.9000',
      renew_usd: '99.9000',
      min_period: 2,
      register_periods: [2, 4, 6, 8, 10],
      renew_periods: [2, 4, 6, 8, 10],
      featured_rank: null,
      featured_tagline: null,
    }
    vi.mocked(createServiceClient).mockReturnValue(
      client({ fx_rates: ok(RATE), pricing_settings: ok(SETTINGS), tlds: ok([ai]) }) as never,
    )
    const [priced] = (await loadPricedCatalogue())?.tlds ?? []
    expect(priced).toMatchObject({
      tld: 'ai',
      minPeriod: 2,
      registerPeriods: [2, 4, 6, 8, 10],
      firstTerm: { years: 2, priceKobo: 2 * (priced?.registration.priceKobo ?? 0) },
      renewalTerm: { years: 2 },
    })
  })

  /**
   * The point of the split: a throw is never cached, a `null` is. A dropped
   * connection must not become an hour of "prices unavailable".
   */
  it.each(['fx_rates', 'pricing_settings', 'tlds'] as const)(
    'throws, rather than returning a cacheable null, when %s fails in transit',
    async (table) => {
      vi.mocked(createServiceClient).mockReturnValue(
        client({
          fx_rates: ok(RATE),
          pricing_settings: ok(SETTINGS),
          tlds: ok(TLDS),
          [table]: dropped,
        }) as never,
      )
      await expect(loadPricedCatalogue()).rejects.toBeInstanceOf(PricingReadError)
    },
  )

  it.each([
    ['no active rate', { fx_rates: ok(null) }],
    ['no pricing settings', { pricing_settings: ok(null) }],
    ['an empty catalogue', { tlds: ok([]) }],
  ] as const)('returns null for genuinely missing data: %s', async (_, missing) => {
    vi.mocked(createServiceClient).mockReturnValue(
      client({
        fx_rates: ok(RATE),
        pricing_settings: ok(SETTINGS),
        tlds: ok(TLDS),
        ...missing,
      }) as never,
    )
    await expect(loadPricedCatalogue()).resolves.toBeNull()
  })
})

describe('getPricedCatalogue (what pages call)', () => {
  it('withholds prices for the request when a read fails, and logs no data', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      client({ fx_rates: dropped, pricing_settings: ok(SETTINGS), tlds: ok(TLDS) }) as never,
    )
    expect(await getPricedCatalogue()).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      { err: 'fx_rates: TypeError: fetch failed' },
      'pricing read failed — withholding prices for this request',
    )
  })

  it('tries again on the next request once the connection is back', async () => {
    vi.mocked(createServiceClient)
      .mockReturnValueOnce(
        client({ fx_rates: dropped, pricing_settings: ok(SETTINGS), tlds: ok(TLDS) }) as never,
      )
      .mockReturnValueOnce(healthy() as never)

    expect(await getPricedCatalogue()).toBeNull()
    const priced = await getPricedCatalogue()
    expect(priced?.tlds).toHaveLength(1)
    expect(createServiceClient).toHaveBeenCalledTimes(2)
  })
})

describe('the price version (L8)', () => {
  it('is the same for the same prices, and changes when any price does', async () => {
    vi.mocked(createServiceClient).mockReturnValue(healthy() as never)
    const first = await readPricedCatalogue()
    const again = await readPricedCatalogue()
    expect(first?.version).toMatch(/^[0-9a-f]{16}$/)
    expect(again?.version).toBe(first?.version)

    vi.mocked(createServiceClient).mockReturnValue(
      client({
        fx_rates: ok({ ...RATE, costing_rate: 1510 }),
        pricing_settings: ok(SETTINGS),
        tlds: ok(TLDS),
      }) as never,
    )
    expect((await readPricedCatalogue())?.version).not.toBe(first?.version)

    vi.mocked(createServiceClient).mockReturnValue(
      client({
        fx_rates: ok(RATE),
        pricing_settings: ok({ ...SETTINGS, vat_pct: 10 }),
        tlds: ok(TLDS),
      }) as never,
    )
    expect((await readPricedCatalogue())?.version).not.toBe(first?.version)
  })
})

describe('what the catalogue says about each extension', () => {
  const row = (name: string, overrides: Record<string, unknown> = {}) => ({
    ...TLDS[0],
    name,
    featured_rank: null,
    featured_tagline: null,
    ...overrides,
  })

  it('features extensions in the order the database ranks them, not alphabetically', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      client({
        fx_rates: ok(RATE),
        pricing_settings: ok(SETTINGS),
        tlds: ok([
          row('africa', { featured_rank: 2, featured_tagline: 'For the continent' }),
          row('com', { featured_rank: 1 }),
          row('org'),
        ]),
      }) as never,
    )
    const priced = await readPricedCatalogue()

    expect(priced?.tlds.map((t) => t.tld)).toEqual(['africa', 'com', 'org'])
    expect(priced?.featured.map((t) => [t.tld, t.tagline])).toEqual([
      ['com', null],
      ['africa', 'For the continent'],
    ])
  })

  it('prices no transfer where the registry quotes none, rather than inventing one', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      client({
        fx_rates: ok(RATE),
        pricing_settings: ok(SETTINGS),
        tlds: ok([row('com'), row('ng', { transfer_usd: null, restore_usd: null })]),
      }) as never,
    )
    const priced = await readPricedCatalogue()

    expect(priced?.tlds.find((t) => t.tld === 'com')?.transfer).not.toBeNull()
    expect(priced?.tlds.find((t) => t.tld === 'ng')?.transfer).toBeNull()
  })

  it('treats a catalogue read that returns no rows at all as missing data', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      client({ fx_rates: ok(RATE), pricing_settings: ok(SETTINGS), tlds: ok(null) }) as never,
    )
    await expect(readPricedCatalogue()).resolves.toBeNull()
    expect(logger.error).toHaveBeenCalledWith('catalogue is empty — cannot price')
  })

  it('still withholds prices, and logs something readable, when the failure is not an Error', async () => {
    vi.mocked(createServiceClient).mockImplementation(() => {
      const rejected = Promise.reject('connection reset')
      const query = Object.assign(rejected, {
        select: () => query,
        eq: () => query,
        order: () => query,
        range: () => query,
        maybeSingle: () => query,
      })
      return { from: () => query } as never
    })

    expect(await getPricedCatalogue()).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      { err: 'connection reset' },
      'pricing read failed — withholding prices for this request',
    )
  })
})
