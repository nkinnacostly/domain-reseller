import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PricedCatalogue } from '@/features/pricing/queries/pricing'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))

const { getPricedCatalogue } = await import('@/features/pricing/queries/pricing')
const { cacheTag } = await import('next/cache')
const { getLlmsFullTxt, getLlmsTxt } = await import('../queries/llms')

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
const tlds = priceCatalogue(['zone', 'com', 'africa', 'co'].map(record), INPUTS)
const CATALOGUE: PricedCatalogue = {
  tlds,
  featured: [{ ...(tlds.find((t) => t.tld === 'africa') as (typeof tlds)[number]), tagline: null }],
  effectiveRate: 1334,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
})

describe('llms.txt from the live catalogue', () => {
  it('lists the featured and well-known extensions, refreshed with prices', async () => {
    const text = await getLlmsTxt()
    expect(cacheTag).toHaveBeenCalledWith('pricing')
    expect(text).toContain('Search 4 domain extensions')
    expect(text).toMatch(/\[\.africa\]\(http[^)]+\/domains\/africa\)/)
    expect(text).toMatch(/\[\.com\]/)
    // .zone is neither featured nor well known: it waits for llms-full.txt.
    expect(text).not.toContain('[.zone]')
  })

  it('puts every extension, A–Z, and the help centre’s answers in the full file', async () => {
    const text = await getLlmsFullTxt()
    const listed = [...text.matchAll(/^- \[\.([a-z.]+)\]/gm)].map((match) => match[1])
    expect(listed).toEqual(['africa', 'co', 'com', 'zone'])
    expect(text).toContain('### Do I need hosting before I buy a domain?')
    expect(text).toContain('### How can I pay?')
    expect(text).toContain('hello@mydomainshub.com')
  })

  it('says prices are unavailable when they are withheld (N5b)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    const text = await getLlmsTxt()
    expect(text).toContain('Prices are briefly unavailable')
    expect(text).not.toMatch(/₦/)
  })
})
