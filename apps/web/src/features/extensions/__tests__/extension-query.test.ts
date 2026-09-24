import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PricedCatalogue } from '@/features/pricing/queries/pricing'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/supabase/public', () => ({ createPublicClient: vi.fn() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const { createPublicClient } = await import('@/lib/supabase/public')
const { getPricedCatalogue } = await import('@/features/pricing/queries/pricing')
const { cacheTag } = await import('next/cache')
const { extensionStaticParams, getExtensionPage, listExtensionPages, loadCatalogueFacts } =
  await import('../queries/extension')

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: 10.61,
  restoreUsd: null,
  isCountryCode: name.length === 2,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const tlds = priceCatalogue(['com', 'net', 'africa', 'co', 'io'].map(record), INPUTS)
const CATALOGUE: PricedCatalogue = {
  tlds,
  featured: ['net', 'com'].map((tld) => ({
    ...(tlds.find((t) => t.tld === tld) as (typeof tlds)[number]),
    tagline: null,
  })),
  effectiveRate: 1334,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

const ROWS = [
  {
    name: 'africa',
    is_country_code: false,
    min_period: 1,
    max_period: 10,
    requires_extra_fields: false,
    min_chars: 3,
    max_chars: 63,
    is_transferable: true,
    featured_tagline: 'Built for brands with a continental reach',
  },
  {
    name: 'com',
    is_country_code: false,
    min_period: 1,
    max_period: 10,
    requires_extra_fields: false,
    min_chars: null,
    max_chars: null,
    is_transferable: null,
    featured_tagline: null,
  },
]

/** The Supabase query builder: every chained call returns the same promise. */
function catalogue(result: { data: unknown; error: { message: string } | null }) {
  const from = vi.fn(() => {
    const query = Object.assign(Promise.resolve(result), {
      select: () => query,
      order: () => query,
      range: () => query,
    })
    return query
  })
  vi.mocked(createPublicClient).mockReturnValue({ from } as never)
  return from
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
})

describe('loadCatalogueFacts', () => {
  it('reads every sellable extension with the publishable key, under the pricing tag', async () => {
    const from = catalogue({ data: ROWS, error: null })
    const facts = await loadCatalogueFacts()

    expect(from).toHaveBeenCalledWith('tlds')
    expect(cacheTag).toHaveBeenCalledWith('pricing')
    expect(facts[0]).toEqual({
      tld: 'africa',
      isCountryCode: false,
      minPeriod: 1,
      maxPeriod: 10,
      requiresExtraFields: false,
      minChars: 3,
      maxChars: 63,
      isTransferable: true,
      tagline: 'Built for brands with a continental reach',
    })
  })

  it('throws on a failed read, so the failure is never cached', async () => {
    catalogue({ data: null, error: { message: 'fetch failed' } })
    await expect(loadCatalogueFacts()).rejects.toThrow('tlds: fetch failed')
  })

  it('is empty when nothing is visible', async () => {
    catalogue({ data: null, error: null })
    expect(await loadCatalogueFacts()).toEqual([])
  })
})

describe('getExtensionPage', () => {
  it('joins the catalogue’s facts with the priced entry', async () => {
    catalogue({ data: ROWS, error: null })
    const page = await getExtensionPage('africa')

    expect(page).toMatchObject({
      kind: 'found',
      facts: { tld: 'africa', minChars: 3 },
      pricing: { tld: 'africa' },
      vatPct: 7.5,
    })
  })

  it('still describes the extension, prices withheld, when the price list is down (N5b)', async () => {
    catalogue({ data: ROWS, error: null })
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)

    expect(await getExtensionPage('com')).toMatchObject({
      kind: 'found',
      pricing: null,
      vatPct: null,
    })
  })

  it('falls back to the priced entry’s facts when the catalogue read fails', async () => {
    catalogue({ data: null, error: { message: 'fetch failed' } })
    const page = await getExtensionPage('io')

    expect(page).toMatchObject({
      kind: 'found',
      facts: { tld: 'io', isCountryCode: true, minChars: null, tagline: null },
      pricing: { tld: 'io' },
    })
  })

  it('is missing for an extension we do not sell — unknown or paused alike', async () => {
    catalogue({ data: ROWS, error: null })
    expect(await getExtensionPage('ng')).toEqual({ kind: 'missing' })
  })

  it('cannot say when both reads fail', async () => {
    catalogue({ data: null, error: { message: 'fetch failed' } })
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    expect(await getExtensionPage('com')).toEqual({ kind: 'unavailable' })
  })
})

describe('extensionStaticParams', () => {
  it('prerenders the featured extensions, then the popular ones we sell', async () => {
    expect(await extensionStaticParams()).toEqual(
      ['net', 'com', 'africa', 'io', 'co'].map((tld) => ({ tld })),
    )
  })

  it('still names one extension when prices cannot be read, as Cache Components requires', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    expect(await extensionStaticParams()).toEqual([{ tld: 'com' }])
  })
})

describe('listExtensionPages', () => {
  it('lists every extension in the catalogue, whether or not it is priced', async () => {
    catalogue({ data: ROWS, error: null })
    expect(await listExtensionPages()).toEqual(
      ROWS.map((row) => ({ tld: row.name, isCountryCode: row.is_country_code })),
    )
  })

  it('falls back to the priced list when the catalogue cannot be read', async () => {
    catalogue({ data: null, error: { message: 'fetch failed' } })
    const pages = await listExtensionPages()
    expect(pages?.map((page) => page.tld)).toEqual(tlds.map((entry) => entry.tld))
  })

  it('lists nothing rather than a short list when neither can be read', async () => {
    catalogue({ data: null, error: { message: 'fetch failed' } })
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    expect(await listExtensionPages()).toBeNull()
  })
})
