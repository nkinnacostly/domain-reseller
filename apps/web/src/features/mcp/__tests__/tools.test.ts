import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { checkAvailability } from '@/features/search/queries/availability'
import { getLengthRules } from '@/features/search/queries/length-rules'
import { logger } from '@/lib/logger'
import { withinLimit } from '@/lib/rate-limit'

const sent = { ip: '102.89.1.1' }
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': sent.ip }),
}))
vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: vi.fn(async (scope: string) => `${scope}:test`),
  withinLimit: vi.fn(async () => true),
}))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('@/features/search/queries/length-rules', () => ({
  getLengthRules: vi.fn(async () => ({})),
}))

const { searchDomains, getPrices, createCartLink, MCP_TOOLS, MCP_TOOLS_READ_ONLY } = await import(
  '../queries/tools'
)

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: 11.31,
  restoreUsd: null,
  isCountryCode: name === 'ng',
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const tlds = priceCatalogue([record('com'), record('ng')], INPUTS)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(getLengthRules).mockResolvedValue({})
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds,
    featured: tlds.map((pricing) => ({ ...pricing, tagline: null })),
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date(),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  })
  vi.mocked(checkAvailability).mockResolvedValue({
    ok: true,
    results: [
      { name: 'getpaid', tld: 'ng', domain: 'getpaid.ng', status: 'available' },
      { name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'registered' },
    ],
  })
})

describe('search_domains', () => {
  it('checks the name on the extension asked for first, priced with its renewal from the tables', async () => {
    const info = vi.spyOn(logger, 'info')
    const answer = await searchDomains({ query: 'GetPaid.ng' })
    expect(checkAvailability).toHaveBeenCalledWith(['getpaid'], ['ng', 'com'], 'normal')
    expect(answer.isError).toBeUndefined()
    expect(answer.text).toMatch(
      /getpaid\.ng: available — ₦[\d,]+ for the first year, then ₦[\d,]+ a year/,
    )
    expect(answer.text).toContain('getpaid.com: taken')
    expect(answer.text).toContain('before VAT (7.5%)')
    expect(answer.structured?.results).toEqual([
      expect.objectContaining({
        domain: 'getpaid.ng',
        status: 'available',
        price: expect.any(Object),
      }),
      { domain: 'getpaid.com', status: 'registered' },
    ])
    // FR-S7: the name searched is never logged.
    expect(info).toHaveBeenCalled()
    expect(JSON.stringify(info.mock.calls)).not.toContain('getpaid')
  })

  it('refuses a bad name, a busy period and an unreachable registry without guessing', async () => {
    expect((await searchDomains({ query: '-' })).isError).toBe(true)
    expect((await searchDomains({})).isError).toBe(true)
    vi.mocked(withinLimit).mockResolvedValueOnce(false)
    expect((await searchDomains({ query: 'getpaid' })).text).toContain('Too many searches')
    vi.mocked(checkAvailability).mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect((await searchDomains({ query: 'getpaid' })).text).toContain(
      "couldn't reach the registry",
    )
    vi.mocked(getPricedCatalogue).mockResolvedValueOnce(null)
    expect((await searchDomains({ query: 'getpaid' })).text).toContain(
      'Prices are briefly unavailable',
    )
  })
})

describe('get_prices', () => {
  it('quotes the extensions asked for, says which are not sold, and never asks the registry', async () => {
    const answer = await getPrices({ extensions: ['.NG', 'zz'] })
    expect(answer.text).toMatch(
      /\.ng: ₦[\d,]+ for the first year, then ₦[\d,]+ a year; transfer in ₦/,
    )
    expect(answer.text).toContain('Not sold here: .zz')
    expect(checkAvailability).not.toHaveBeenCalled()
    expect((await getPrices({})).structured?.prices).toEqual([
      expect.objectContaining({ extension: 'com' }),
    ])
  })
})

describe('create_cart_link', () => {
  it('makes a link to our site for the names we sell, adding nothing', async () => {
    const answer = await createCartLink({ domains: ['GetPaid.ng', 'getpaid.ng', 'thing.zz'] })
    expect(answer.structured).toEqual({
      url: 'http://localhost:3000/cart/add?d=getpaid.ng',
      domains: ['getpaid.ng'],
      leftOut: ['thing.zz'],
    })
    expect(answer.text).toContain('Nothing is added or charged until they do')
    expect(checkAvailability).not.toHaveBeenCalled()
    expect((await createCartLink({ domains: ['thing.zz'] })).isError).toBe(true)
    expect((await createCartLink({ domains: [] })).isError).toBe(true)
  })

  it('gives Claude’s shared addresses their own, larger bucket', async () => {
    sent.ip = '160.79.106.20'
    await getPrices({})
    expect(withinLimit).toHaveBeenCalledWith('mcp:anthropic', expect.objectContaining({ max: 600 }))
    sent.ip = '102.89.1.1'
    vi.mocked(withinLimit).mockClear()
    await getPrices({})
    expect(withinLimit).toHaveBeenCalledWith('mcp:test', expect.objectContaining({ max: 60 }))
  })

  it('gives ChatGPT’s published addresses one shared bucket too (AI phase 5)', async () => {
    sent.ip = '104.210.139.200'
    await getPrices({})
    expect(withinLimit).toHaveBeenCalledWith('mcp:openai', expect.objectContaining({ max: 600 }))
    sent.ip = '104.210.139.208'
    vi.mocked(withinLimit).mockClear()
    await getPrices({})
    expect(withinLimit).toHaveBeenCalledWith('mcp:test', expect.objectContaining({ max: 60 }))
    sent.ip = '102.89.1.1'
  })

  it('offers ChatGPT search and prices only: no link straight to a checkout (AI phase 5)', () => {
    expect(MCP_TOOLS_READ_ONLY.map((tool) => tool.name)).toEqual(['search_domains', 'get_prices'])
    // OpenAI's rule 6.3: all three hints, as explicit booleans, on every tool.
    for (const tool of MCP_TOOLS_READ_ONLY) {
      expect(typeof tool.annotations?.readOnlyHint).toBe('boolean')
      expect(typeof tool.annotations?.destructiveHint).toBe('boolean')
      expect(typeof tool.annotations?.openWorldHint).toBe('boolean')
    }
  })

  it('offers three read-only tools, each titled and marked read-only', () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
      'search_domains',
      'get_prices',
      'create_cart_link',
    ])
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations).toMatchObject({
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
      })
    }
  })
})
