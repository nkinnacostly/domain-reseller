import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { checkAvailability } from '@/features/search/queries/availability'
import * as store from '../queries/store'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
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

const { addToCart, updateCartLine, acceptCurrentPrices } = await import('../actions/cart')

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string, minPeriod = 1): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const tlds = priceCatalogue([record('com'), record('dev', 2)], INPUTS)
const com = tlds[0]
if (!com) throw new Error('fixture')

const available = (status = 'available') => ({
  ok: true as const,
  results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: status as 'available' }],
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds,
    featured: [],
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date(),
    rateId: 'rate-1',
    vatPct: 7.5,
  })
  vi.mocked(checkAvailability).mockResolvedValue(available())
  vi.mocked(store.currentOwner).mockResolvedValue({
    owner: { kind: 'user', userId: 'user-1' },
    anonToken: null,
  })
  vi.mocked(store.findOrCreateCartId).mockResolvedValue('cart-1')
  vi.mocked(store.findCartId).mockResolvedValue('cart-1')
  vi.mocked(store.countLines).mockResolvedValue(1)
})

describe('addToCart', () => {
  it('refuses an extension we do not sell', async () => {
    const result = await addToCart({ domain: 'getpaid.xyz' })
    expect(result?.data).toEqual({ error: "We don't sell .xyz." })
    expect(store.insertLine).not.toHaveBeenCalled()
  })

  it('refuses a name taken since the search (FR-C7 starts here)', async () => {
    vi.mocked(checkAvailability).mockResolvedValue(available('registered'))
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({ error: 'getpaid.com was taken while you were looking.' })
    expect(store.insertLine).not.toHaveBeenCalled()
  })

  it('refuses when availability cannot be confirmed, rather than guessing', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'unavailable' })
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({ error: expect.stringMatching(/couldn't confirm/) })
  })

  it('stops at the cart limit', async () => {
    vi.mocked(store.countLines).mockResolvedValue(50)
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({ error: expect.stringMatching(/up to 50/) })
    expect(store.insertLine).not.toHaveBeenCalled()
  })

  it('quotes from the catalogue and records the rate it was priced at', async () => {
    const result = await addToCart({ domain: 'https://www.GetPaid.com/' })
    expect(store.insertLine).toHaveBeenCalledWith('cart-1', {
      domain: 'getpaid.com',
      tld: 'com',
      periodYears: 1,
      quotedTotalKobo: com.registration.priceKobo,
      quotedRenewalKobo: com.renewal.priceKobo,
      quotedFxRateId: 'rate-1',
    })
    expect(result?.data).toEqual({ count: 1 })
    expect(jar.set).toHaveBeenCalledWith('dr_cart_count', '1', expect.anything())
  })

  it('starts at the minimum period an extension allows', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({
      ok: true,
      results: [{ name: 'getpaid', tld: 'dev', domain: 'getpaid.dev', status: 'available' }],
    })
    await addToCart({ domain: 'getpaid.dev' })
    expect(vi.mocked(store.insertLine).mock.calls[0]?.[1].periodYears).toBe(2)
  })

  it('gives an anonymous shopper an httpOnly cart cookie', async () => {
    vi.mocked(store.currentOwner).mockResolvedValue({ owner: null, anonToken: null })
    await addToCart({ domain: 'getpaid.com' })
    expect(jar.set).toHaveBeenCalledWith(
      'dr_cart',
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    )
  })
})

describe('updateCartLine', () => {
  const stored = {
    id: '00000000-0000-4000-8000-000000000001',
    domain: 'getpaid.com',
    tld: 'com',
    periodYears: 1,
    privacy: true,
    autoRenew: true,
    quotedTotalKobo: 1,
    quotedRenewalKobo: 1,
    quotedAt: '2026-09-23T10:00:00.000Z',
  }

  it('re-quotes at today’s price when the period changes', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([stored])
    await updateCartLine({ lineId: stored.id, periodYears: 3 })
    expect(store.updateLine).toHaveBeenCalledWith(
      'cart-1',
      stored.id,
      expect.objectContaining({
        period_years: 3,
        quoted_total_kobo: com.registration.priceKobo + 2 * com.renewal.priceKobo,
        quoted_fx_rate_id: 'rate-1',
      }),
    )
  })

  it('changes a toggle without touching the price', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([stored])
    await updateCartLine({ lineId: stored.id, autoRenew: false })
    expect(store.updateLine).toHaveBeenCalledWith('cart-1', stored.id, { auto_renew: false })
  })

  it('refuses a line that is not in your cart', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([])
    const result = await updateCartLine({ lineId: stored.id, privacy: false })
    expect(result?.data).toEqual({ error: 'That domain is no longer in your cart.' })
    expect(store.updateLine).not.toHaveBeenCalled()
  })
})

describe('acceptCurrentPrices', () => {
  it('re-quotes every line we still sell', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([
      {
        id: 'a',
        domain: 'getpaid.com',
        tld: 'com',
        periodYears: 1,
        privacy: true,
        autoRenew: true,
        quotedTotalKobo: 1,
        quotedRenewalKobo: 1,
        quotedAt: '2026-09-23T10:00:00.000Z',
      },
      {
        id: 'b',
        domain: 'getpaid.gone',
        tld: 'gone',
        periodYears: 1,
        privacy: true,
        autoRenew: true,
        quotedTotalKobo: 1,
        quotedRenewalKobo: 1,
        quotedAt: '2026-09-23T10:00:00.000Z',
      },
    ])
    await acceptCurrentPrices()
    expect(store.updateLine).toHaveBeenCalledTimes(1)
    expect(store.updateLine).toHaveBeenCalledWith(
      'cart-1',
      'a',
      expect.objectContaining({ quoted_total_kobo: com.registration.priceKobo }),
    )
  })
})
