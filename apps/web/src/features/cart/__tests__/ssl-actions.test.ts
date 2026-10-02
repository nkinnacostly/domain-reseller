import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSslCatalogue } from '@/features/ssl/queries/catalogue'
import { sslNameInUse } from '@/features/ssl/queries/names'
import { withinLimit } from '@/lib/rate-limit'
import * as store from '../queries/store'

vi.mock('@/features/ssl/queries/catalogue', () => ({ getSslCatalogue: vi.fn() }))
vi.mock('@/features/ssl/queries/names', () => ({ sslNameInUse: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  withinLimit: vi.fn(),
  addressKey: async (scope: string) => `${scope}:test`,
}))
vi.mock('../queries/store', () => ({
  currentOwner: vi.fn(),
  findCartId: vi.fn(),
  findOrCreateCartId: vi.fn(),
  countLines: vi.fn(),
  insertSslLine: vi.fn(),
  deleteSslLine: vi.fn(),
  mergeAnonymousCart: vi.fn(),
}))
const jar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() }
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => jar }))

const { addSslToCart, removeSslCartLine } = await import('../actions/ssl')

/** FR-SSL-6: certificates go in the cart priced by us, for a name we have checked. */

const PRODUCT = (over: Record<string, unknown> = {}) => ({
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
  ...over,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(sslNameInUse).mockResolvedValue(false)
  vi.mocked(getSslCatalogue).mockResolvedValue({
    products: [
      PRODUCT(),
      PRODUCT({ productCode: '352', name: 'Sectigo PositiveSSL Wildcard', isWildcard: true }),
    ],
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'v',
  })
  vi.mocked(store.currentOwner).mockResolvedValue({
    owner: { kind: 'user', userId: 'user-1' },
    anonToken: null,
  })
  vi.mocked(store.findOrCreateCartId).mockResolvedValue('cart-1')
  vi.mocked(store.findCartId).mockResolvedValue('cart-1')
  vi.mocked(store.countLines).mockResolvedValue(1)
})

describe('addSslToCart', () => {
  it('adds a certificate for a checked name, at our price, and updates the badge', async () => {
    const result = await addSslToCart({ productCode: '351', name: ' Shop.Example.com ' })
    expect(result?.data).toEqual({ count: 1, name: 'shop.example.com' })
    expect(store.insertSslLine).toHaveBeenCalledWith('cart-1', {
      productCode: '351',
      commonName: 'shop.example.com',
      quotedTotalKobo: 1_350_000,
      quotedFxRateId: 'rate-1',
    })
    expect(jar.set).toHaveBeenCalledWith('dr_cart_count', '1', expect.anything())
  })

  it('names a wildcard *.host, as the supplier must know it', async () => {
    const result = await addSslToCart({ productCode: '352', name: 'example.com' })
    expect(result?.data).toMatchObject({ name: '*.example.com' })
    expect(sslNameInUse).toHaveBeenCalledWith('*.example.com')
  })

  it.each([
    ['exa mple.com', 'letters, numbers'],
    ['*.example.com', 'Leave out the "*."'],
    ['10.0.0.1', 'not an IP address'],
  ])('refuses %s before anything is quoted', async (name, message) => {
    const result = await addSslToCart({ productCode: '351', name })
    expect(result?.data).toMatchObject({ error: expect.stringContaining(message) })
    expect(store.insertSslLine).not.toHaveBeenCalled()
  })

  it('refuses a name a certificate here already holds — the supplier reaches only the first', async () => {
    vi.mocked(sslNameInUse).mockResolvedValue(true)
    const result = await addSslToCart({ productCode: '351', name: 'example.com' })
    expect(result?.data).toMatchObject({
      error: expect.stringContaining('already bought through us'),
    })
    expect(store.insertSslLine).not.toHaveBeenCalled()
  })

  it('sells nothing when the name, the price or the product cannot be confirmed', async () => {
    vi.mocked(sslNameInUse).mockResolvedValueOnce(null)
    expect((await addSslToCart({ productCode: '351', name: 'example.com' }))?.data).toMatchObject({
      error: expect.stringContaining("couldn't check that name"),
    })
    expect((await addSslToCart({ productCode: '999', name: 'example.com' }))?.data).toEqual({
      error: 'We do not sell that certificate.',
    })
    vi.mocked(getSslCatalogue).mockResolvedValueOnce(null)
    expect((await addSslToCart({ productCode: '351', name: 'example.com' }))?.data).toMatchObject({
      error: expect.stringContaining('Prices are unavailable'),
    })
    expect(store.insertSslLine).not.toHaveBeenCalled()
  })

  it('holds to the cart’s size and the per-address allowance', async () => {
    vi.mocked(store.countLines).mockResolvedValue(50)
    expect((await addSslToCart({ productCode: '351', name: 'example.com' }))?.data).toMatchObject({
      error: expect.stringContaining('A cart holds up to 50 items'),
    })
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect((await addSslToCart({ productCode: '351', name: 'example.com' }))?.data).toMatchObject({
      error: expect.stringContaining('Wait a little'),
    })
  })

  it('says something went wrong when the cart cannot be written', async () => {
    vi.mocked(store.insertSslLine).mockRejectedValue(new Error('db'))
    expect((await addSslToCart({ productCode: '351', name: 'example.com' }))?.data).toEqual({
      error: 'Something went wrong updating your cart. Please try again.',
    })
  })
})

describe('removeSslCartLine', () => {
  it('removes a line from your own cart and updates the badge', async () => {
    vi.mocked(store.countLines).mockResolvedValue(0)
    const result = await removeSslCartLine({ lineId: '00000000-0000-4000-8000-000000000001' })
    expect(result?.data).toEqual({ count: 0 })
    expect(store.deleteSslLine).toHaveBeenCalledWith(
      'cart-1',
      '00000000-0000-4000-8000-000000000001',
    )
  })

  it('has nothing to remove without a cart, and reports a failed write', async () => {
    vi.mocked(store.currentOwner).mockResolvedValue({ owner: null, anonToken: null })
    expect(
      (await removeSslCartLine({ lineId: '00000000-0000-4000-8000-000000000001' }))?.data,
    ).toEqual({ count: 0 })
    vi.mocked(store.currentOwner).mockResolvedValue({
      owner: { kind: 'user', userId: 'u' },
      anonToken: null,
    })
    vi.mocked(store.deleteSslLine).mockRejectedValue(new Error('db'))
    expect(
      (await removeSslCartLine({ lineId: '00000000-0000-4000-8000-000000000001' }))?.data,
    ).toMatchObject({
      error: expect.any(String),
    })
  })
})
