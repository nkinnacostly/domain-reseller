import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { after } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { checkAvailability } from '@/features/search/queries/availability'
import { getLengthRules } from '@/features/search/queries/length-rules'
import { getSslCatalogue } from '@/features/ssl/queries/catalogue'
import { sslNameInUse } from '@/features/ssl/queries/names'
import { requirePaymentEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { withinLimit } from '@/lib/rate-limit'
import { createServiceClient } from '@/lib/supabase/service'
import * as store from '../queries/store'

/**
 * The funnel's cart adds (ADMIN-SPEC §6, B15): `bump_funnel('cart_add', side)`
 * once per add that put something in the cart, after the response, on the
 * side checkout would be paid on — and a count that fails never fails the add.
 */

vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: vi.fn(),
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('@/features/search/queries/length-rules', () => ({ getLengthRules: vi.fn() }))
vi.mock('@/features/ssl/queries/catalogue', () => ({ getSslCatalogue: vi.fn() }))
vi.mock('@/features/ssl/queries/names', () => ({ sslNameInUse: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: async (scope: string) => `${scope}:test`,
  withinLimit: vi.fn(),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))
vi.mock('../queries/store', () => ({
  currentOwner: vi.fn(),
  findCartId: vi.fn(),
  findOrCreateCartId: vi.fn(),
  countLines: vi.fn(),
  insertLine: vi.fn(),
  insertSslLine: vi.fn(),
  loadLines: vi.fn(),
  updateLine: vi.fn(),
  deleteLine: vi.fn(),
  deleteSslLine: vi.fn(),
  mergeAnonymousCart: vi.fn(),
}))

const { addToCart, addDomainsToCart, removeCartLine, updateCartLine } = await import(
  '../actions/cart'
)
const { addSslToCart } = await import('../actions/ssl')

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

const TEST_KEYS = {
  secretKey: 'FLWSECK_TEST-x-X',
  publicKey: 'FLWPUBK_TEST-x-X',
  webhookHash: 'hash',
  testMode: true,
}

let rpc: ReturnType<typeof vi.fn>

/** What `after` was handed, run as Next would once the response has gone. */
async function afterResponse() {
  for (const [task] of vi.mocked(after).mock.calls) await (task as () => Promise<void>)()
}

const bumps = () => rpc.mock.calls.filter(([name]) => name === 'bump_funnel')

beforeEach(() => {
  vi.resetAllMocks()
  rpc = vi.fn(async () => ({ data: null, error: null }))
  vi.mocked(createServiceClient).mockReturnValue({ rpc } as never)
  vi.mocked(requirePaymentEnv).mockReturnValue(TEST_KEYS)
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
        status: 'available' as const,
      })),
    ),
  }))
  vi.mocked(store.currentOwner).mockResolvedValue({
    owner: { kind: 'user', userId: 'user-1' },
    anonToken: null,
  })
  vi.mocked(store.findOrCreateCartId).mockResolvedValue('cart-1')
  vi.mocked(store.findCartId).mockResolvedValue('cart-1')
  vi.mocked(store.countLines).mockResolvedValue(1)
  vi.mocked(store.loadLines).mockResolvedValue([])
  vi.mocked(sslNameInUse).mockResolvedValue(false)
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
  } as never)
})

describe('a cart add is counted once, after the response', () => {
  it('counts one domain added, on the side checkout would be paid on', async () => {
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({ count: 1 })
    // Nothing is counted while the shopper waits.
    expect(rpc).not.toHaveBeenCalled()
    await afterResponse()
    expect(bumps()).toEqual([['bump_funnel', { p_event: 'cart_add', p_test_mode: true }]])
  })

  it('counts on the live side with live keys', async () => {
    vi.mocked(requirePaymentEnv).mockReturnValue({ ...TEST_KEYS, testMode: false })
    await addToCart({ domain: 'getpaid.com' })
    await afterResponse()
    expect(bumps()).toEqual([['bump_funnel', { p_event: 'cart_add', p_test_mode: false }]])
  })

  it('counts a bulk add once, however many names it put in the cart', async () => {
    const result = await addDomainsToCart({ domains: ['one.com', 'two.com', 'three.io'] })
    expect(result?.data).toMatchObject({ added: ['one.com', 'two.com', 'three.io'] })
    await afterResponse()
    expect(bumps()).toHaveLength(1)
  })

  it('counts a certificate added', async () => {
    const result = await addSslToCart({ productCode: '351', name: 'shop.example.com' })
    expect(result?.data).toEqual({ count: 1, name: 'shop.example.com' })
    expect(rpc).not.toHaveBeenCalled()
    await afterResponse()
    expect(bumps()).toEqual([['bump_funnel', { p_event: 'cart_add', p_test_mode: true }]])
  })
})

describe('nothing is counted when nothing was added', () => {
  it('not for a name taken since the search', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({
      ok: true,
      results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'registered' }],
    })
    await addToCart({ domain: 'getpaid.com' })
    await afterResponse()
    expect(after).not.toHaveBeenCalled()
    expect(bumps()).toEqual([])
  })

  it('not when the cart could not be written', async () => {
    vi.mocked(store.insertLine).mockRejectedValue(new Error('db down'))
    const result = await addToCart({ domain: 'getpaid.com' })
    expect(result?.data).toEqual({ error: expect.stringMatching(/went wrong/) })
    expect(after).not.toHaveBeenCalled()
  })

  it('not for a bulk add whose names were all in the cart already, or all taken', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([
      { id: 'one.com', domain: 'one.com', tld: 'com' } as never,
    ])
    await addDomainsToCart({ domains: ['one.com'] })
    vi.mocked(store.loadLines).mockResolvedValue([])
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'unavailable' })
    await addDomainsToCart({ domains: ['two.com'] })
    expect(after).not.toHaveBeenCalled()
  })

  it('not for a certificate whose name we already hold', async () => {
    vi.mocked(sslNameInUse).mockResolvedValue(true)
    await addSslToCart({ productCode: '351', name: 'shop.example.com' })
    expect(after).not.toHaveBeenCalled()
  })

  it('not for changing or removing a line', async () => {
    vi.mocked(store.loadLines).mockResolvedValue([
      { id: '00000000-0000-4000-8000-000000000001', domain: 'one.com', tld: 'com' } as never,
    ])
    await updateCartLine({ lineId: '00000000-0000-4000-8000-000000000001', privacy: true })
    await removeCartLine({ lineId: '00000000-0000-4000-8000-000000000001' })
    expect(after).not.toHaveBeenCalled()
  })
})

describe('a count that fails never fails the add', () => {
  it('when the database refuses it', async () => {
    const warn = vi.spyOn(logger, 'warn')
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'no function' } })
    const result = await addToCart({ domain: 'getpaid.com' })
    await afterResponse()
    expect(result?.data).toEqual({ count: 1 })
    // The error's code only: nothing about the shopper or their cart (N13).
    expect(warn).toHaveBeenCalledWith({ code: 'PGRST202' }, 'cart add not counted')
    warn.mockRestore()
  })

  it('when the database cannot be reached', async () => {
    rpc.mockRejectedValue(new Error('fetch failed'))
    const result = await addSslToCart({ productCode: '351', name: 'shop.example.com' })
    await expect(afterResponse()).resolves.toBeUndefined()
    expect(result?.data).toEqual({ count: 1, name: 'shop.example.com' })
  })

  it('when payments are not set up, so there is no side to count on', async () => {
    vi.mocked(requirePaymentEnv).mockImplementation(() => {
      throw new Error('Payments are not configured')
    })
    const result = await addDomainsToCart({ domains: ['one.com'] })
    await expect(afterResponse()).resolves.toBeUndefined()
    expect(result?.data).toMatchObject({ added: ['one.com'] })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('when work after the response cannot be scheduled', async () => {
    vi.mocked(after).mockImplementation(() => {
      throw new Error('`after` was called outside a request scope')
    })
    expect((await addToCart({ domain: 'getpaid.com' }))?.data).toEqual({ count: 1 })
    expect((await addSslToCart({ productCode: '351', name: 'a.example.com' }))?.data).toEqual({
      count: 1,
      name: 'a.example.com',
    })
    expect(rpc).not.toHaveBeenCalled()
  })
})
