import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { checkAvailability } from '@/features/search/queries/availability'
import { env } from '@/lib/env'
import * as store from '../queries/store'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/ssl/queries/catalogue', () => ({ getSslCatalogue: vi.fn() }))
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
  loadSslLines: vi.fn(),
  requoteSslLine: vi.fn(),
}))
const jar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => jar }))

const { addToCart, updateCartLine, removeCartLine, acceptCurrentPrices } = await import(
  '../actions/cart'
)

const FAILED = 'Something went wrong updating your cart. Please try again.'
const LINE_ID = '00000000-0000-4000-8000-000000000001'

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
/** .ai as the sync stores it (29 Sept 2026): $99.90 a year, sold in 2- to 10-year blocks. */
const aiRecord: TldRecord = {
  ...record('ai', 2),
  registerUsd: 99.9,
  renewUsd: 99.9,
  isCountryCode: true,
  registerPeriods: [2, 4, 6, 8, 10],
  renewPeriods: [2, 4, 6, 8, 10],
}
const tlds = priceCatalogue([record('com'), record('dev', 2), aiRecord], INPUTS)
const com = tlds[0]
const ai = tlds.find((entry) => entry.tld === 'ai')
if (!com || !ai) throw new Error('fixture')

const available = (status = 'available') => ({
  ok: true as const,
  results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: status as 'available' }],
})

beforeEach(() => {
  vi.resetAllMocks()
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
  vi.mocked(checkAvailability).mockResolvedValue(available())
  vi.mocked(store.loadSslLines).mockResolvedValue([])
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

  it('asks the registry again rather than trust a cached answer (FR-S6)', async () => {
    await addToCart({ domain: 'getpaid.com' })
    expect(checkAvailability).toHaveBeenCalledWith(['getpaid'], ['com'], 'high', { fresh: true })
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

  it('adds a block-sold extension at its two-year minimum, never one year (.ai)', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({
      ok: true,
      results: [{ name: 'getpaid', tld: 'ai', domain: 'getpaid.ai', status: 'available' }],
    })
    await addToCart({ domain: 'getpaid.ai' })
    expect(store.insertLine).toHaveBeenCalledWith('cart-1', {
      domain: 'getpaid.ai',
      tld: 'ai',
      periodYears: 2,
      quotedTotalKobo: 2 * ai.registration.priceKobo,
      quotedRenewalKobo: ai.renewal.priceKobo,
      quotedFxRateId: 'rate-1',
    })
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

  it('refuses a period the registry does not sell, and names the ones it does (.ai)', async () => {
    const aiLine = { ...stored, domain: 'getpaid.ai', tld: 'ai', periodYears: 2 }
    vi.mocked(store.loadLines).mockResolvedValue([aiLine])
    for (const periodYears of [1, 3, 5]) {
      const result = await updateCartLine({ lineId: stored.id, periodYears })
      expect(result?.data).toEqual({ error: '.ai can be registered for 2, 4, 6, 8 or 10 years.' })
    }
    expect(store.updateLine).not.toHaveBeenCalled()
  })

  it('re-quotes a block-sold line for a period it sells', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([
      { ...stored, domain: 'getpaid.ai', tld: 'ai', periodYears: 2 },
    ])
    await updateCartLine({ lineId: stored.id, periodYears: 6 })
    expect(store.updateLine).toHaveBeenCalledWith(
      'cart-1',
      stored.id,
      expect.objectContaining({
        period_years: 6,
        quoted_total_kobo: 6 * ai.registration.priceKobo,
        quoted_renewal_kobo: ai.renewal.priceKobo,
      }),
    )
  })
})

describe('acceptCurrentPrices', () => {
  it('re-quotes SSL certificates at today’s price too, and leaves one we no longer sell (FR-SSL-6)', async () => {
    const { getSslCatalogue } = await import('@/features/ssl/queries/catalogue')
    vi.mocked(store.loadLines).mockResolvedValue([])
    vi.mocked(store.loadSslLines).mockResolvedValue([
      {
        id: 's1',
        productCode: '351',
        commonName: 'getpaid.com',
        quotedTotalKobo: 1,
        quotedAt: '2026-09-23T10:00:00.000Z',
      },
      {
        id: 's2',
        productCode: '999',
        commonName: 'other.com',
        quotedTotalKobo: 1,
        quotedAt: '2026-09-23T10:00:00.000Z',
      },
    ])
    vi.mocked(getSslCatalogue).mockResolvedValue({
      products: [
        {
          productCode: '351',
          name: 'Sectigo PositiveSSL Certificate',
          vendor: 'Sectigo',
          validationType: 'DV',
          isWildcard: false,
          isMultiDomain: false,
          includedNames: 1,
          isReissueFree: true,
          createUsd: 6.99,
          price: { costKobo: 1_048_500, priceKobo: 1_350_000, marginKobo: 301_500 },
        },
      ],
      rateId: 'rate-1',
      vatPct: 7.5,
      version: 'v',
    })
    await expect(acceptCurrentPrices()).resolves.toMatchObject({ data: { ok: true } })
    expect(store.requoteSslLine).toHaveBeenCalledTimes(1)
    expect(store.requoteSslLine).toHaveBeenCalledWith(
      'cart-1',
      's1',
      expect.objectContaining({ quoted_total_kobo: 1_350_000, quoted_fx_rate_id: 'rate-1' }),
    )
  })

  it('refuses to accept prices it cannot read for certificates', async () => {
    const { getSslCatalogue } = await import('@/features/ssl/queries/catalogue')
    vi.mocked(store.loadSslLines).mockResolvedValue([
      {
        id: 's1',
        productCode: '351',
        commonName: 'getpaid.com',
        quotedTotalKobo: 1,
        quotedAt: '2026-09-23T10:00:00.000Z',
      },
    ])
    vi.mocked(getSslCatalogue).mockResolvedValue(null)
    await expect(acceptCurrentPrices()).resolves.toMatchObject({ data: { error: FAILED } })
    expect(store.requoteSslLine).not.toHaveBeenCalled()
  })

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
      expect.objectContaining({ period_years: 1, quoted_total_kobo: com.registration.priceKobo }),
    )
  })

  it('moves a line off a period no longer sold to the one the cart showed, and prices that', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([
      {
        id: 'c',
        domain: 'getpaid.ai',
        tld: 'ai',
        periodYears: 3,
        privacy: false,
        autoRenew: true,
        quotedTotalKobo: 1,
        quotedRenewalKobo: 1,
        quotedAt: '2026-09-23T10:00:00.000Z',
      },
    ])
    await acceptCurrentPrices()
    expect(store.updateLine).toHaveBeenCalledWith(
      'cart-1',
      'c',
      expect.objectContaining({
        period_years: 4,
        quoted_total_kobo: 4 * ai.registration.priceKobo,
      }),
    )
  })
})

describe('addToCart — what it refuses', () => {
  it('refuses a bare name with no extension', async () => {
    const result = await addToCart({ domain: 'getpaid' })
    expect(result?.data).toEqual({ error: 'That is not a domain we can add.' })
    expect(getPricedCatalogue).not.toHaveBeenCalled()
  })

  it('adds nothing while prices are unavailable, rather than guessing one', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({
      error: 'Prices are unavailable right now, so nothing can be added.',
    })
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(store.insertLine).not.toHaveBeenCalled()
  })

  it('treats a missing availability answer as taken', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({ ok: true, results: [] })
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({ error: 'getpaid.com was taken while you were looking.' })
  })

  it('says something went wrong, and sets no count, when the cart cannot be written', async () => {
    vi.mocked(store.insertLine).mockRejectedValue(new Error('connection reset'))
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({ error: FAILED })
    expect(jar.set).not.toHaveBeenCalledWith('dr_cart_count', expect.anything(), expect.anything())
  })
})

describe('addToCart — whose cart it goes in', () => {
  it('moves the anonymous cart into the account on the first add after signing in', async () => {
    vi.mocked(store.currentOwner).mockResolvedValue({
      owner: { kind: 'user', userId: 'user-1' },
      anonToken: 'anon-token',
    })
    await addToCart({ domain: 'getpaid.com' })
    expect(store.mergeAnonymousCart).toHaveBeenCalledWith('anon-token', 'user-1')
    expect(jar.delete).toHaveBeenCalledWith('dr_cart')
    expect(store.findOrCreateCartId).toHaveBeenCalledWith({ kind: 'user', userId: 'user-1' })
  })

  it('keeps using the anonymous cart a shopper already has', async () => {
    const owner = { kind: 'anon' as const, tokenHash: 'a'.repeat(64) }
    vi.mocked(store.currentOwner).mockResolvedValue({ owner, anonToken: 'anon-token' })
    await addToCart({ domain: 'getpaid.com' })
    expect(store.findOrCreateCartId).toHaveBeenCalledWith(owner)
    expect(jar.set).not.toHaveBeenCalledWith('dr_cart', expect.anything(), expect.anything())
    expect(store.mergeAnonymousCart).not.toHaveBeenCalled()
  })

  it('marks the cart cookies secure in production', async () => {
    const settings = env as { NODE_ENV?: string }
    const before = settings.NODE_ENV
    settings.NODE_ENV = 'production'
    try {
      vi.mocked(store.currentOwner).mockResolvedValue({ owner: null, anonToken: null })
      await addToCart({ domain: 'getpaid.com' })
      expect(jar.set).toHaveBeenCalledWith(
        'dr_cart',
        expect.any(String),
        expect.objectContaining({ secure: true, httpOnly: true }),
      )
      expect(jar.set).toHaveBeenCalledWith(
        'dr_cart_count',
        '1',
        expect.objectContaining({ secure: true }),
      )
    } finally {
      settings.NODE_ENV = before
    }
  })
})

describe('updateCartLine — what it refuses', () => {
  const stored = {
    id: LINE_ID,
    domain: 'getpaid.com',
    tld: 'com',
    periodYears: 1,
    privacy: true,
    autoRenew: true,
    quotedTotalKobo: 1,
    quotedRenewalKobo: 1,
    quotedAt: '2026-09-23T10:00:00.000Z',
  }

  it('changes nothing for a shopper with no cart', async () => {
    vi.mocked(store.currentOwner).mockResolvedValue({ owner: null, anonToken: null })
    const result = await updateCartLine({ lineId: LINE_ID, privacy: false })
    expect(result?.data).toEqual({ error: FAILED })
    expect(store.findCartId).not.toHaveBeenCalled()
    expect(store.updateLine).not.toHaveBeenCalled()
  })

  it('changes nothing when the owner has no cart row yet', async () => {
    vi.mocked(store.findCartId).mockResolvedValue(null)
    const result = await updateCartLine({ lineId: LINE_ID, privacy: false })
    expect(result?.data).toEqual({ error: FAILED })
    expect(store.loadLines).not.toHaveBeenCalled()
  })

  it('will not re-quote a period for an extension we stopped selling', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([
      { ...stored, tld: 'gone', domain: 'getpaid.gone' },
    ])
    const result = await updateCartLine({ lineId: LINE_ID, periodYears: 2 })
    expect(result?.data).toEqual({ error: 'We no longer sell .gone.' })
    expect(store.updateLine).not.toHaveBeenCalled()
  })

  it('will not re-quote a period while prices are unavailable', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([stored])
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    const result = await updateCartLine({ lineId: LINE_ID, periodYears: 2 })
    expect(result?.data).toEqual({ error: 'We no longer sell .com.' })
    expect(store.updateLine).not.toHaveBeenCalled()
  })

  it('says something went wrong when the line cannot be saved', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([stored])
    vi.mocked(store.updateLine).mockRejectedValue(new Error('connection reset'))
    const result = await updateCartLine({ lineId: LINE_ID, privacy: false })
    expect(result?.data).toEqual({ error: FAILED })
  })

  it('rejects a line id that is not a UUID before touching the cart', async () => {
    const result = await updateCartLine({ lineId: 'line-1', privacy: false })
    expect(result?.validationErrors).toBeDefined()
    expect(store.currentOwner).not.toHaveBeenCalled()
  })
})

describe('updateCartLine — what it changes', () => {
  const stored = {
    id: LINE_ID,
    domain: 'getpaid.com',
    tld: 'com',
    periodYears: 2,
    privacy: true,
    autoRenew: true,
    quotedTotalKobo: 1,
    quotedRenewalKobo: 1,
    quotedAt: '2026-09-23T10:00:00.000Z',
  }

  beforeEach(() => vi.mocked(store.loadLines).mockResolvedValue([stored]))

  it('keeps the held price when the same period is chosen again', async () => {
    const result = await updateCartLine({ lineId: LINE_ID, periodYears: 2, privacy: false })
    expect(result?.data).toEqual({ ok: true })
    expect(getPricedCatalogue).not.toHaveBeenCalled()
    expect(store.updateLine).toHaveBeenCalledWith('cart-1', LINE_ID, { privacy: false })
  })

  it('turns contact privacy off and on', async () => {
    await updateCartLine({ lineId: LINE_ID, privacy: false })
    expect(store.updateLine).toHaveBeenCalledWith('cart-1', LINE_ID, { privacy: false })
  })

  it('stamps a fresh lock on a re-quoted period', async () => {
    await updateCartLine({ lineId: LINE_ID, periodYears: 1 })
    const patch = vi.mocked(store.updateLine).mock.calls[0]?.[2]
    expect(patch).toMatchObject({
      period_years: 1,
      quoted_total_kobo: com.registration.priceKobo,
      quoted_renewal_kobo: com.renewal.priceKobo,
    })
    expect(Date.parse(String(patch?.quoted_at))).not.toBeNaN()
  })
})

describe('removeCartLine', () => {
  it('removes the line from your own cart and corrects the badge count', async () => {
    vi.mocked(store.countLines).mockResolvedValue(0)
    const result = await removeCartLine({ lineId: LINE_ID })
    expect(store.deleteLine).toHaveBeenCalledWith('cart-1', LINE_ID)
    expect(result?.data).toEqual({ count: 0 })
    expect(jar.set).toHaveBeenCalledWith('dr_cart_count', '0', expect.anything())
  })

  it('reports an empty cart for a shopper who has none, deleting nothing', async () => {
    vi.mocked(store.currentOwner).mockResolvedValue({ owner: null, anonToken: null })
    const result = await removeCartLine({ lineId: LINE_ID })
    expect(result?.data).toEqual({ count: 0 })
    expect(store.deleteLine).not.toHaveBeenCalled()
  })

  it('says something went wrong when the line cannot be removed', async () => {
    vi.mocked(store.deleteLine).mockRejectedValue(new Error('connection reset'))
    const result = await removeCartLine({ lineId: LINE_ID })
    expect(result?.data).toEqual({ error: FAILED })
    expect(jar.set).not.toHaveBeenCalled()
  })
})

describe('acceptCurrentPrices — what it refuses', () => {
  it('re-quotes nothing for a shopper with no cart', async () => {
    vi.mocked(store.currentOwner).mockResolvedValue({ owner: null, anonToken: null })
    const result = await acceptCurrentPrices()
    expect(result?.data).toEqual({ error: FAILED })
    expect(store.updateLine).not.toHaveBeenCalled()
  })

  it('re-quotes nothing while prices are unavailable', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    const result = await acceptCurrentPrices()
    expect(result?.data).toEqual({ error: FAILED })
    expect(store.loadLines).not.toHaveBeenCalled()
  })

  it('says something went wrong when the lines cannot be read', async () => {
    vi.mocked(store.loadLines).mockRejectedValue(new Error('connection reset'))
    const result = await acceptCurrentPrices()
    expect(result?.data).toEqual({ error: FAILED })
  })

  it('succeeds on an empty cart without writing anything', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([])
    const result = await acceptCurrentPrices()
    expect(result?.data).toEqual({ ok: true })
    expect(store.updateLine).not.toHaveBeenCalled()
  })
})
