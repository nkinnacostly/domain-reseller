import { type PricingInputs, priceCatalogue, type TldRecord, vatKobo } from '@dr/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { hashCartToken } from '../lib/token'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
const jar = { get: vi.fn() }
vi.mock('next/headers', () => ({ cookies: async () => jar }))

const { getCartView } = await import('../queries/cart')

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
const tlds = priceCatalogue([record('com')], INPUTS)
const com = tlds[0]
if (!com) throw new Error('fixture')

const NOW = new Date('2026-09-23T10:10:00.000Z')
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'line-1',
  domain: 'getpaid.com',
  tld: 'com',
  period_years: 1,
  privacy: true,
  auto_renew: true,
  quoted_total_kobo: com.registration.priceKobo,
  quoted_renewal_kobo: com.renewal.priceKobo,
  quoted_at: '2026-09-23T10:00:00.000Z',
  ...overrides,
})

type Answer = { data?: unknown; error?: unknown }

/** The service-role client: the next queued answer per table, and every rpc call. */
function fakeService(answers: Record<string, Answer[]>) {
  const order: string[] = []
  const rpc = vi.fn(async (name: string, _args: unknown) => {
    order.push(`rpc:${name}`)
    return { error: null }
  })
  const from = (table: string) => {
    order.push(table)
    const answer = answers[table]?.shift() ?? { data: null, error: null }
    const query = Promise.resolve(answer) as Promise<Answer> & Record<string, unknown>
    for (const method of ['select', 'eq', 'order']) query[method] = () => query
    query.maybeSingle = () => Promise.resolve(answer)
    return query
  }
  vi.mocked(createServiceClient).mockReturnValue({ from, rpc } as never)
  return { rpc, order }
}

function signedIn(user: { id: string } | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
  } as never)
}

const settings = env as { PRICE_LOCK_MINUTES?: number }
const lockBefore = settings.PRICE_LOCK_MINUTES

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  settings.PRICE_LOCK_MINUTES = 30
  jar.get.mockReturnValue(undefined)
  signedIn({ id: 'user-1' })
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds,
    featured: [],
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: NOW,
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  })
})

afterEach(() => {
  vi.useRealTimers()
  settings.PRICE_LOCK_MINUTES = lockBefore
})

describe('getCartView', () => {
  it('is empty for a visitor who has added nothing, without touching the database', async () => {
    signedIn(null)
    expect(await getCartView()).toEqual({ state: 'empty' })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('is empty when the owner has no cart yet', async () => {
    fakeService({ carts: [{ data: null }] })
    expect(await getCartView()).toEqual({ state: 'empty' })
    expect(getPricedCatalogue).not.toHaveBeenCalled()
  })

  it('is empty when the cart has no lines left', async () => {
    fakeService({ carts: [{ data: { id: 'cart-1' } }], cart_items: [{ data: [] }] })
    expect(await getCartView()).toEqual({ state: 'empty' })
  })

  it('withholds the cart rather than show it without prices (N5b)', async () => {
    fakeService({ carts: [{ data: { id: 'cart-1' } }], cart_items: [{ data: [row()] }] })
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    expect(await getCartView()).toEqual({ state: 'unpriced' })
  })

  it('prices each line now, holding a recent quote, and adds VAT on the subtotal', async () => {
    fakeService({
      carts: [{ data: { id: 'cart-1' } }],
      cart_items: [{ data: [row({ quoted_total_kobo: 1_000_000 })] }],
    })
    const view = await getCartView()
    if (view.state !== 'ready') throw new Error(`expected a ready cart, got ${view.state}`)

    expect(view.lines[0]).toMatchObject({
      status: 'held',
      payableKobo: 1_000_000,
      heldUntil: '2026-09-23T10:30:00.000Z',
    })
    expect(view.totals).toEqual({
      subtotalKobo: 1_000_000,
      vatKobo: vatKobo(1_000_000, 7.5),
      totalKobo: 1_000_000 + vatKobo(1_000_000, 7.5),
      needsAcknowledgement: false,
      unavailableCount: 0,
    })
    expect(view).toMatchObject({ vatPct: 7.5, lockMinutes: 30 })
  })

  it('asks for acknowledgement once a lapsed quote no longer matches today’s price', async () => {
    fakeService({
      carts: [{ data: { id: 'cart-1' } }],
      cart_items: [{ data: [row({ quoted_total_kobo: 1, quoted_at: '2026-09-23T09:00:00Z' })] }],
    })
    const view = await getCartView()
    if (view.state !== 'ready') throw new Error(`expected a ready cart, got ${view.state}`)
    expect(view.lines[0]?.status).toBe('changed')
    expect(view.totals.needsAcknowledgement).toBe(true)
  })

  it('leaves an extension we stopped selling out of the total', async () => {
    fakeService({
      carts: [{ data: { id: 'cart-1' } }],
      cart_items: [{ data: [row(), row({ id: 'line-2', domain: 'getpaid.gone', tld: 'gone' })] }],
    })
    const view = await getCartView()
    if (view.state !== 'ready') throw new Error(`expected a ready cart, got ${view.state}`)
    expect(view.lines.map((line) => line.status)).toEqual(['held', 'unavailable'])
    expect(view.totals).toMatchObject({
      subtotalKobo: com.registration.priceKobo,
      unavailableCount: 1,
    })
  })

  it('brings an anonymous cart into the account before reading it, on sign-in', async () => {
    jar.get.mockReturnValue({ value: 'anon-token' })
    const { rpc, order } = fakeService({
      carts: [{ data: { id: 'cart-1' } }],
      cart_items: [{ data: [row()] }],
    })
    await getCartView()
    expect(rpc).toHaveBeenCalledWith('merge_anonymous_cart', {
      p_token_hash: hashCartToken('anon-token'),
      p_user_id: 'user-1',
    })
    expect(order.slice(0, 2)).toEqual(['rpc:merge_anonymous_cart', 'carts'])
  })

  it('reads an anonymous shopper’s cart without trying to merge it', async () => {
    signedIn(null)
    jar.get.mockReturnValue({ value: 'anon-token' })
    const { rpc } = fakeService({
      carts: [{ data: { id: 'cart-1' } }],
      cart_items: [{ data: [row()] }],
    })
    expect((await getCartView()).state).toBe('ready')
    expect(rpc).not.toHaveBeenCalled()
  })
})
