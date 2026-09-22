import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCartView } from '@/features/cart/queries/cart'
import { deleteLine, findCartId } from '@/features/cart/queries/store'
import { checkAvailability } from '@/features/search/queries/availability'
import { requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/features/cart/queries/cart', () => ({ getCartView: vi.fn() }))
vi.mock('@/features/cart/queries/store', () => ({ findCartId: vi.fn(), deleteLine: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('@/lib/flutterwave', () => ({ createPaymentLink: vi.fn() }))
vi.mock('@/lib/gateway', () => ({ callGateway: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))

const { placeOrder } = await import('../actions/place-order')

const LINE = {
  id: 'line-1',
  domain: 'getpaid.com',
  tld: 'com',
  periodYears: 1,
  privacy: true,
  autoRenew: true,
  privacyOffered: true,
  payableKobo: 1_840_000,
  renewalKobo: 1_870_000,
}
const TOTALS = {
  subtotalKobo: 1_840_000,
  vatKobo: 138_000,
  totalKobo: 1_978_000,
  needsAcknowledgement: false,
  unavailableCount: 0,
}

const INPUT = {
  registrant: {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
    phoneCountryCode: '234',
    phone: '0803 123 4567',
    addressLine1: '12 Admiralty Way',
    city: 'Lagos',
    state: 'Lagos',
    zipCode: '100001',
    country: 'NG',
  },
  confirmed: true as const,
  expectedTotalKobo: 1_978_000,
}

/** A chainable double: a real promise, with the query methods the action calls. */
function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'in', 'update', 'insert']) node[method] = () => node
  node.single = async () => result
  node.maybeSingle = async () => result
  return node
}

let inserted: { orders: unknown[]; items: unknown[] }

beforeEach(() => {
  vi.clearAllMocks()
  inserted = { orders: [], items: [] }

  vi.mocked(requirePaymentEnv).mockReturnValue({
    secretKey: 'FLWSECK_TEST-x-X',
    publicKey: 'FLWPUBK_TEST-x-X',
    webhookHash: 'hash',
    testMode: true,
  })
  vi.mocked(getCartView).mockResolvedValue({
    state: 'ready',
    lines: [LINE],
    totals: TOTALS,
    vatPct: 7.5,
    lockMinutes: 30,
  } as never)
  vi.mocked(checkAvailability).mockResolvedValue({
    ok: true,
    results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'available' }],
  })
  vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 500 })
  vi.mocked(createPaymentLink).mockResolvedValue('https://checkout.test/pay/1')

  const userClient = {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } }),
    },
    from: () => chain({ data: { id: 'contact-1' }, error: null }),
  }
  vi.mocked(createClient).mockResolvedValue(userClient as never)

  const service = {
    from: (table: string) => {
      if (table === 'tlds') {
        return chain({
          data: [{ name: 'com', register_usd: 11.31, renew_usd: 11.51, is_country_code: false }],
        })
      }
      if (table === 'pricing_settings') return chain({ data: { icann_fee_usd: 0.2 } })
      if (table === 'fx_rates') return chain({ data: { id: 'rate-1' } })
      if (table === 'orders') {
        const node = chain({ data: { id: 'order-1', order_number: 'ND-001001' }, error: null })
        const insert = node.insert as () => unknown
        node.insert = (row: unknown) => {
          inserted.orders.push(row)
          return insert()
        }
        return node
      }
      if (table === 'order_items') {
        return {
          insert: async (rows: unknown) => {
            inserted.items.push(rows)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  vi.mocked(createServiceClient).mockReturnValue(service as never)
})

describe('placeOrder — nothing is created or charged when a check fails', () => {
  it('refuses when the total moved since the page loaded (FR-C4)', async () => {
    const result = await placeOrder({ ...INPUT, expectedTotalKobo: 1 })
    expect(result?.data).toEqual({ error: expect.stringMatching(/total has changed/) })
    expect(inserted.orders).toEqual([])
  })

  it('removes a name registered since it was added, and charges nothing (FR-C7)', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({
      ok: true,
      results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'registered' }],
    })
    vi.mocked(findCartId).mockResolvedValue('cart-1')

    const result = await placeOrder(INPUT)

    expect(deleteLine).toHaveBeenCalledWith('cart-1', 'line-1')
    expect(result?.data).toEqual({
      error: expect.stringMatching(/getpaid.com was registered by someone else/),
    })
    expect(inserted.orders).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('stops if availability cannot be confirmed', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'unavailable' })
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/haven't been charged/) })
    expect(inserted.orders).toEqual([])
  })

  it('refuses with live keys when the supplier float cannot cover the order (FR-C8, I3)', async () => {
    vi.mocked(requirePaymentEnv).mockReturnValue({
      secretKey: 'FLWSECK-live-X',
      publicKey: 'FLWPUBK-live-X',
      webhookHash: 'hash',
      testMode: false,
    })
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 0 })

    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/haven't been charged/) })
    expect(inserted.orders).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('stops if the float cannot be read at all', async () => {
    vi.mocked(callGateway).mockRejectedValue(new Error('gateway down'))
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/haven't been charged/) })
    expect(inserted.orders).toEqual([])
  })

  it('refuses nameservers it cannot use, before anything else', async () => {
    const result = await placeOrder({ ...INPUT, nameservers: 'just-one.example.com' })
    expect(result?.data).toMatchObject({ field: 'nameservers' })
    expect(checkAvailability).not.toHaveBeenCalled()
  })
})

describe('placeOrder — the order', () => {
  it('records the order with its registrant snapshot and hands over to Flutterwave', async () => {
    const result = await placeOrder({ ...INPUT, nameservers: 'ns1.host.com\nns2.host.com' })

    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders[0]).toMatchObject({
      user_id: 'user-1',
      subtotal_kobo: 1_840_000,
      vat_kobo: 138_000,
      total_kobo: 1_978_000,
      float_check: 'covered',
      test_mode: true,
      nameservers: ['ns1.host.com', 'ns2.host.com'],
      registrant: expect.objectContaining({ phone: '8031234567', phoneCountryCode: '234' }),
    })
    expect(createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ amountKobo: 1_978_000, orderNumber: 'ND-001001' }),
    )
  })

  it('lets a shortfall through only with test keys, and records that it did', async () => {
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 0 })
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders[0]).toMatchObject({ float_check: 'shortfall_test_mode' })
  })

  it('says so, and charges nothing, if Flutterwave cannot be reached', async () => {
    vi.mocked(createPaymentLink).mockRejectedValue(new Error('Flutterwave 503'))
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/payment provider/) })
  })
})
