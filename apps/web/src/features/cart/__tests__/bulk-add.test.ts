import {
  type AvailabilityResult,
  type PricingInputs,
  priceCatalogue,
  type TldRecord,
} from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { checkAvailability } from '@/features/search/queries/availability'
import { getLengthRules } from '@/features/search/queries/length-rules'
import { addressKey, withinLimit } from '@/lib/rate-limit'
import { MAX_CART_ITEMS, type StoredLine } from '../lib/lines'
import * as store from '../queries/store'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('@/features/search/queries/length-rules', () => ({ getLengthRules: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: vi.fn(async (scope: string) => `${scope}:hashed`),
  withinLimit: vi.fn(),
}))
vi.mock('../queries/store', () => ({
  currentOwner: vi.fn(),
  findCartId: vi.fn(),
  findOrCreateCartId: vi.fn(),
  countLines: vi.fn(),
  insertLine: vi.fn(),
  loadLines: vi.fn(),
  updateLine: vi.fn(),
  deleteLine: vi.fn(),
  mergeAnonymousCart: vi.fn(),
}))
const jar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => jar }))

const { addDomainsToCart } = await import('../actions/cart')
const { LIMITS } = await import('@/lib/rate-limit')

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const tlds = priceCatalogue([record('com'), record('io')], INPUTS)

/** The gateway's answer: every asked pair, with the status the test gives it. */
function registry(statuses: Record<string, AvailabilityResult['status']> = {}) {
  vi.mocked(checkAvailability).mockImplementation(async (names, extensions) => ({
    ok: true,
    results: names.flatMap((name) =>
      extensions.map((tld) => ({
        name,
        tld,
        domain: `${name}.${tld}`,
        status: statuses[`${name}.${tld}`] ?? 'available',
      })),
    ),
  }))
}

const line = (domain: string): StoredLine => ({
  id: domain,
  domain,
  tld: domain.split('.').slice(1).join('.'),
  periodYears: 1,
  privacy: false,
  autoRenew: true,
  quotedTotalKobo: 1,
  quotedRenewalKobo: 1,
  quotedAt: '2026-09-24T00:00:00Z',
})

const run = async (domains: string[]) => (await addDomainsToCart({ domains }))?.data

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
  registry()
  vi.mocked(store.currentOwner).mockResolvedValue({
    owner: { kind: 'user', userId: 'user-1' },
    anonToken: null,
  })
  vi.mocked(store.findOrCreateCartId).mockResolvedValue('cart-1')
  vi.mocked(store.loadLines).mockResolvedValue([])
  vi.mocked(store.countLines).mockResolvedValue(2)
})

describe('addDomainsToCart — refusals first (FR-S5)', () => {
  it('refuses an address that has added too much lately, before any registry call', async () => {
    vi.mocked(withinLimit).mockResolvedValue(false)

    expect(await run(['getpaid.com'])).toEqual({
      error: "You've added a lot in the last few minutes. Wait a little and try again.",
    })
    expect(withinLimit).toHaveBeenCalledWith('bulk_add:hashed', LIMITS.bulkAddToCart)
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(store.insertLine).not.toHaveBeenCalled()
  })

  it('adds nothing when prices are withheld (N5b)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    expect(await run(['getpaid.com'])).toEqual({
      error: 'Prices are unavailable right now, so nothing can be added.',
    })
    expect(store.insertLine).not.toHaveBeenCalled()
  })

  it('says why each name it could not take was left out, asking the registry about none of them', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({ io: { min: 3, max: 63 } })

    const result = await run(['not_a_name', 'getpaid', 'school.edu', 'ab.io', 'pаypal.com'])

    expect(result).toEqual({
      count: 2,
      added: [],
      notAdded: [
        { domain: 'not_a_name', reason: 'Not a domain we can add' },
        { domain: 'getpaid', reason: 'Not a domain we can add' },
        { domain: 'school.edu', reason: "We don't sell .edu" },
        { domain: 'ab.io', reason: 'Too short for .io (3–63 characters)' },
        { domain: 'pаypal.com', reason: 'Not a domain we can add' },
      ],
    })
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('re-checks every name, and leaves out one taken since the search', async () => {
    registry({ 'getpaid.com': 'registered', 'mybrand.io': 'unknown' })

    const result = await run(['getpaid.com', 'mybrand.io', 'other.com'])

    expect(result).toMatchObject({
      added: ['other.com'],
      notAdded: [
        { domain: 'getpaid.com', reason: 'Taken while you were looking' },
        { domain: 'mybrand.io', reason: "We couldn't confirm it's still free" },
      ],
    })
    expect(store.insertLine).toHaveBeenCalledTimes(1)
  })

  it('leaves out names the registry could not be asked about', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'unavailable' })

    const result = await run(['getpaid.com'])

    expect(result).toMatchObject({
      added: [],
      notAdded: [{ domain: 'getpaid.com', reason: "We couldn't confirm it's still free" }],
    })
  })

  it('stops at a full cart and says so for the rest', async () => {
    vi.mocked(store.loadLines).mockResolvedValue(
      Array.from({ length: MAX_CART_ITEMS - 1 }, (_, index) => line(`held${index}.com`)),
    )

    const result = await run(['first.com', 'second.com'])

    expect(result).toMatchObject({
      added: ['first.com'],
      notAdded: [{ domain: 'second.com', reason: `A cart holds up to ${MAX_CART_ITEMS} domains` }],
    })
  })

  it('reports a failed write without claiming anything was added', async () => {
    vi.mocked(store.insertLine).mockRejectedValue(new Error('connection reset'))
    expect(await run(['getpaid.com'])).toEqual({
      error: 'Something went wrong updating your cart. Please try again.',
    })
  })
})

describe('addDomainsToCart — adding (FR-S5, FR-S8)', () => {
  it('asks the registry once per extension, at normal priority, never high (PRD V4)', async () => {
    await run(['getpaid.com', 'mybrand.com', 'other.io'])

    expect(checkAvailability).toHaveBeenCalledTimes(1)
    expect(checkAvailability).toHaveBeenCalledWith(['getpaid', 'mybrand', 'other'], ['com', 'io'])
  })

  it('writes each free name at the catalogue price, and sets the cart badge', async () => {
    const result = await run(['getpaid.com'])

    expect(result).toEqual({ count: 2, added: ['getpaid.com'], notAdded: [] })
    expect(store.insertLine).toHaveBeenCalledWith('cart-1', {
      domain: 'getpaid.com',
      tld: 'com',
      periodYears: 1,
      quotedTotalKobo: tlds[0]?.registration.priceKobo,
      quotedRenewalKobo: tlds[0]?.renewal.priceKobo,
      quotedFxRateId: 'rate-1',
    })
    expect(jar.set).toHaveBeenCalledWith('dr_cart_count', '2', expect.any(Object))
  })

  it('stores an international name in its ASCII form and names it as read (FR-S8)', async () => {
    const result = await run(['café.com'])

    expect(result).toMatchObject({ added: ['café.com'] })
    expect(vi.mocked(store.insertLine).mock.calls[0]?.[1].domain).toBe('xn--caf-dma.com')
  })

  it('counts a name already in the cart as added, without a second line', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([line('getpaid.com')])

    const result = await run(['getpaid.com', 'GetPaid.com'])

    expect(result).toMatchObject({ added: ['getpaid.com'], notAdded: [] })
    expect(store.insertLine).not.toHaveBeenCalled()
  })
})
