import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { addressKey, withinLimit } from '@/lib/rate-limit'
import { checkAvailability } from '../queries/availability'
import { getLengthRules } from '../queries/length-rules'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('../queries/length-rules', () => ({ getLengthRules: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: vi.fn(),
  withinLimit: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const { checkBulkNames } = await import('../actions/bulk')
const { LIMITS } = await import('@/lib/rate-limit')

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string, isCountryCode = false): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 12.5,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const tlds = priceCatalogue([record('com'), record('io', true)], INPUTS)

const check = async (names: string[], extensions: string[]) =>
  (await checkBulkNames({ names, tlds: extensions }))?.data

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(addressKey).mockImplementation(async (scope: string) => `${scope}:hashed`)
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(getLengthRules).mockResolvedValue({})
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds,
    featured: [],
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date(),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  })
  vi.mocked(checkAvailability).mockImplementation(async (names, extensions) => ({
    ok: true,
    results: names.flatMap((name) =>
      extensions.map((tld) => ({
        name,
        tld,
        domain: `${name}.${tld}`,
        status: name === 'takenbrand' ? ('registered' as const) : ('available' as const),
      })),
    ),
  }))
})

describe('checkBulkNames — refusals first (FR-S5)', () => {
  it('refuses a block bigger than one supplier call, before counting or asking', async () => {
    const names = Array.from({ length: 21 }, (_, index) => `name${index}`)
    const result = await checkBulkNames({ names, tlds: ['com'] })

    expect(result?.validationErrors).toBeDefined()
    expect(withinLimit).not.toHaveBeenCalled()
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('refuses more than one extension a block (the supplier charges per extension)', async () => {
    const result = await checkBulkNames({ names: ['getpaid'], tlds: ['com', 'net'] })
    expect(result?.validationErrors).toBeDefined()
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('refuses a name that is not one DNS label', async () => {
    const result = await checkBulkNames({ names: ['get paid'], tlds: ['com'] })
    expect(result?.validationErrors).toBeDefined()
  })

  it('checks nothing when prices are withheld (N5b, N8)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    expect(await check(['getpaid'], ['com'])).toEqual({ ok: false, reason: 'unavailable' })
    expect(withinLimit).not.toHaveBeenCalled()
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('stops a connection that has checked a lot lately, before the registry is asked', async () => {
    vi.mocked(withinLimit).mockResolvedValue(false)

    expect(await check(['getpaid'], ['com'])).toEqual({ ok: false, reason: 'limited' })
    expect(withinLimit).toHaveBeenCalledWith('bulk_search:hashed', LIMITS.bulkSearch)
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('never sends a name its extension refuses (FR-S9)', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({ io: { min: 3, max: 63 } })

    await check(['ab', 'getpaid'], ['io'])

    expect(checkAvailability).toHaveBeenCalledWith(['getpaid'], ['io'], 'low', {
      timeoutMs: 30_000,
    })
  })

  it('costs nothing when nothing is left to ask', async () => {
    expect(await check(['getpaid'], ['edu'])).toEqual({ ok: true, results: [], prices: {} })
    expect(withinLimit).not.toHaveBeenCalled()
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('says the registry is busy when the gateway is rate limited', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'rate-limited' })
    expect(await check(['getpaid'], ['com'])).toEqual({ ok: false, reason: 'busy' })
  })

  it('says the registry did not answer when the gateway fails', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'unavailable' })
    expect(await check(['getpaid'], ['com'])).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('checkBulkNames — answers', () => {
  it('asks once, at low priority, so single searches always go first (PRD V4)', async () => {
    await check(['getpaid', 'takenbrand'], ['com'])

    expect(checkAvailability).toHaveBeenCalledOnce()
    expect(checkAvailability).toHaveBeenCalledWith(['getpaid', 'takenbrand'], ['com'], 'low', {
      timeoutMs: 30_000,
    })
    expect(withinLimit).toHaveBeenCalledOnce()
  })

  it('answers each name, with first-year and renewal prices for the extension (N8)', async () => {
    const com = tlds.find((tld) => tld.tld === 'com')

    const result = await check(['getpaid', 'takenbrand'], ['com'])

    expect(result).toEqual({
      ok: true,
      results: [
        { domain: 'getpaid.com', status: 'available' },
        { domain: 'takenbrand.com', status: 'registered' },
      ],
      prices: {
        com: expect.objectContaining({
          registerKobo: com?.registration.priceKobo,
          renewKobo: com?.renewal.priceKobo,
          includesIcannFee: true,
          maxPeriod: 10,
        }),
      },
    })
    if (!result?.ok) throw new Error('expected an answer')
    expect(result.prices.com?.register).toMatch(/^₦[\d,]+$/)
    expect(result.prices.com?.renew).toMatch(/^₦[\d,]+$/)
  })

  it('prices a country-code extension without the ICANN fee (FR-S2)', async () => {
    const io = tlds.find((tld) => tld.tld === 'io')
    const result = await check(['getpaid'], ['io'])
    if (!result?.ok) throw new Error('expected an answer')
    expect(result.prices.io).toMatchObject({
      includesIcannFee: false,
      registerKobo: io?.registration.priceKobo,
    })
  })

  it('asks about each name once, however often it was sent', async () => {
    await check(['getpaid', 'GetPaid'], ['com'])
    expect(checkAvailability).toHaveBeenCalledWith(['getpaid'], ['com'], 'low', {
      timeoutMs: 30_000,
    })
  })
})
