import { userMessageFor } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/flutterwave', () => ({ createPaymentLink: vi.fn() }))
vi.mock('@/lib/gateway', () => ({ callGateway: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))

const { placeRenewal } = await import('../actions/place-renewal')

const DOMAIN_ID = '4f5d3c1a-7b2e-4c8d-9a6f-1e2b3c4d5e6f'
const RENEWAL_KOBO = 1_870_000
/** Two years at the renewal price, plus 7.5% VAT. */
const TWO_YEARS = { subtotal: 3_740_000, vat: 280_500, total: 4_020_500 }
const INPUT = { domainId: DOMAIN_ID, years: 2, expectedTotalKobo: TWO_YEARS.total }

const DOMAIN = {
  id: DOMAIN_ID,
  domain_name: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  test_mode: true,
  local_status: 'active',
  // A year ahead of the test clock, so nine more years fit.
  expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  auto_renew: true,
  privacy_enabled: false,
  registrant: {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
    phone: '8031234567',
    phoneCountryCode: '234',
  },
}

/** A chainable double: a real promise, with the query methods the action calls. */
function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'in', 'limit', 'order', 'update', 'insert']) {
    node[method] = () => node
  }
  node.single = async () => result
  node.maybeSingle = async () => result
  return node
}

let answers: {
  domain: unknown
  open: { data: unknown; error: unknown }
  cost: unknown
  settings: unknown
  fxRate: unknown
  order: { data: unknown; error: unknown }
  lineError: unknown
}
let inserted: { orders: unknown[]; items: unknown[] }
let orderUpdates: unknown[]
let rateLimited: { data: unknown; error: unknown }

beforeEach(() => {
  vi.clearAllMocks()
  inserted = { orders: [], items: [] }
  orderUpdates = []
  rateLimited = { data: true, error: null }
  answers = {
    domain: DOMAIN,
    open: { data: [], error: null },
    cost: { renew_usd: 11.51, is_country_code: false },
    settings: { icann_fee_usd: 0.2 },
    fxRate: { id: 'rate-1' },
    order: { data: { id: 'order-1', order_number: 'ND-001001' }, error: null },
    lineError: null,
  }

  vi.mocked(requirePaymentEnv).mockReturnValue({
    secretKey: 'FLWSECK_TEST-x-X',
    publicKey: 'FLWPUBK_TEST-x-X',
    webhookHash: 'hash',
    testMode: true,
  })
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    vatPct: 7.5,
    tlds: [{ tld: 'com', maxPeriod: 10, renewal: { priceKobo: RENEWAL_KOBO } }],
  } as never)
  vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 500 })
  vi.mocked(createPaymentLink).mockResolvedValue('https://checkout.test/pay/1')

  // The customer's own client (RLS): their domain, and their open renewals.
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } }),
    },
    from: (table: string) => {
      if (table === 'domains') return chain({ data: answers.domain, error: null })
      if (table === 'order_items') return chain(answers.open)
      throw new Error(`unexpected user table ${table}`)
    },
  } as never)

  vi.mocked(createServiceClient).mockReturnValue({
    rpc: vi.fn(async (name: string) => {
      if (name === 'rate_limit_hit') return rateLimited
      throw new Error(`unexpected rpc ${name}`)
    }),
    from: (table: string) => {
      if (table === 'tlds') return chain({ data: answers.cost })
      if (table === 'pricing_settings') return chain({ data: answers.settings })
      if (table === 'fx_rates') return chain({ data: answers.fxRate })
      if (table === 'orders') {
        const node = chain(answers.order)
        const insert = node.insert as () => unknown
        node.insert = (row: unknown) => {
          inserted.orders.push(row)
          return insert()
        }
        node.update = (patch: unknown) => {
          orderUpdates.push(patch)
          return node
        }
        return node
      }
      if (table === 'order_items') {
        return {
          insert: async (row: unknown) => {
            inserted.items.push(row)
            return { error: answers.lineError }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never)
})

const nothingCreated = () => {
  expect(inserted.orders).toEqual([])
  expect(createPaymentLink).not.toHaveBeenCalled()
}

describe('placeRenewal — nothing is created or charged when a check fails', () => {
  it('refuses an account not on the pre-launch allowlist', async () => {
    const settings = env as { CHECKOUT_ALLOWLIST?: string }
    const before = settings.CHECKOUT_ALLOWLIST
    settings.CHECKOUT_ALLOWLIST = 'owner@example.com'
    try {
      const result = await placeRenewal(INPUT)
      expect(result?.data).toEqual({ error: "Payments aren't open yet. You haven't been charged." })
      nothingCreated()
    } finally {
      settings.CHECKOUT_ALLOWLIST = before
    }
  })

  it('pauses an account that keeps trying, and fails closed when the limit cannot be read', async () => {
    for (const answer of [
      { data: false, error: null },
      { data: null, error: { message: 'db down' } },
    ]) {
      rateLimited = answer
      const result = await placeRenewal(INPUT)
      expect(result?.data).toEqual({ error: expect.stringMatching(/^Too many attempts/) })
    }
    expect(callGateway).not.toHaveBeenCalled()
    nothingCreated()
  })

  it('refuses a domain the account cannot see (RLS)', async () => {
    answers.domain = null
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({
      error: "We couldn't find that domain on your account. You haven't been charged.",
    })
    nothingCreated()
  })

  it('refuses a second renewal while one is being made', async () => {
    answers.open = { data: [{ status: 'provisioning' }], error: null }
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/already paid for/) })
    nothingCreated()
  })

  it('refuses when open renewals cannot be read — fails closed', async () => {
    answers.open = { data: null, error: { code: '500', message: 'db down' } }
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/couldn't complete this/) })
    nothingCreated()
  })

  it('withholds a renewal without prices (N5b)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null as never)
    expect((await placeRenewal(INPUT))?.data).toEqual({
      error: expect.stringMatching(/Renewal prices are unavailable/),
    })
    vi.mocked(getPricedCatalogue).mockResolvedValue({ vatPct: 7.5, tlds: [] } as never)
    expect((await placeRenewal(INPUT))?.data).toEqual({
      error: expect.stringMatching(/Renewal prices are unavailable/),
    })
    nothingCreated()
  })

  it('passes on why a domain cannot be renewed', async () => {
    answers.domain = { ...DOMAIN, source: 'demo' }
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({
      error: "Demo domains can’t be renewed. You haven't been charged.",
    })
    nothingCreated()
  })

  it('refuses more years than would fit under the ten-year ceiling', async () => {
    const result = await placeRenewal({ ...INPUT, years: 10 })
    expect(result?.data).toEqual({
      error: expect.stringMatching(/at most 9 years now/),
    })
    nothingCreated()
  })

  it('says "year" when only one more fits', async () => {
    answers.domain = {
      ...DOMAIN,
      expires_at: new Date(Date.now() + 9 * 365 * 86_400_000).toISOString(),
    }
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/at most 1 year now/) })
  })

  it('refuses when the total moved since the page loaded (FR-C4)', async () => {
    const result = await placeRenewal({ ...INPUT, expectedTotalKobo: TWO_YEARS.total - 1 })
    expect(result?.data).toEqual({ error: expect.stringMatching(/renewal price has changed/) })
    nothingCreated()
  })

  it('refuses when the supplier cost or the rate is missing', async () => {
    answers.cost = null
    expect((await placeRenewal(INPUT))?.data).toEqual({
      error: expect.stringMatching(/Renewal prices are unavailable/),
    })
    answers.cost = { renew_usd: 11.51, is_country_code: false }
    answers.fxRate = null
    expect((await placeRenewal(INPUT))?.data).toEqual({
      error: expect.stringMatching(/Renewal prices are unavailable/),
    })
    nothingCreated()
  })

  it('refuses when the supplier balance cannot be read', async () => {
    vi.mocked(callGateway).mockRejectedValue(new Error('gateway down'))
    expect((await placeRenewal(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't complete this just now/),
    })
    vi.mocked(callGateway).mockResolvedValue({ nonsense: true })
    expect((await placeRenewal(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't complete this just now/),
    })
    nothingCreated()
  })

  it('never takes a live payment the float cannot cover (I3)', async () => {
    vi.mocked(requirePaymentEnv).mockReturnValue({
      secretKey: 'FLWSECK-live-X',
      publicKey: 'FLWPUBK-live-X',
      webhookHash: 'hash',
      testMode: false,
    })
    answers.domain = { ...DOMAIN, test_mode: false }
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 20 })
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({ error: userMessageFor('SUPPLIER_INSUFFICIENT_FUNDS') })
    nothingCreated()
  })
})

describe('placeRenewal — the order and the payment', () => {
  it('creates a renewal order for the domain and hands over to Flutterwave', async () => {
    const result = await placeRenewal(INPUT)

    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders).toEqual([
      expect.objectContaining({
        user_id: 'user-1',
        subtotal_kobo: TWO_YEARS.subtotal,
        vat_pct: 7.5,
        vat_kobo: TWO_YEARS.vat,
        total_kobo: TWO_YEARS.total,
        fx_rate_id: 'rate-1',
        tx_ref: expect.stringMatching(/^MDH-/),
        registrant: DOMAIN.registrant,
        float_check: 'covered',
        test_mode: true,
      }),
    ])
    expect(inserted.items).toEqual([
      {
        order_id: 'order-1',
        item_type: 'renew',
        domain_id: DOMAIN_ID,
        domain: 'getpaid.com',
        tld: 'com',
        period_years: 2,
        privacy: false,
        auto_renew: true,
        price_kobo: TWO_YEARS.subtotal,
        renewal_kobo: RENEWAL_KOBO,
      },
    ])
    expect(createPaymentLink).toHaveBeenCalledWith({
      txRef: expect.stringMatching(/^MDH-/),
      amountKobo: TWO_YEARS.total,
      redirectUrl: expect.stringMatching(/\/app\/checkout\/complete\?order=order-1$/),
      customer: { email: 'ada@example.com', name: 'Ada Okafor', phone: '+2348031234567' },
      orderNumber: 'ND-001001',
    })
  })

  it('records a test-mode float shortfall and lets the test payment through', async () => {
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 0 })
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders).toEqual([
      expect.objectContaining({ float_check: 'shortfall_test_mode' }),
    ])
  })

  it('pays with the account email when the domain has no registrant on record', async () => {
    answers.domain = { ...DOMAIN, registrant: null }
    await placeRenewal(INPUT)
    expect(inserted.orders).toEqual([expect.objectContaining({ registrant: {} })])
    expect(createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ customer: { email: 'ada@example.com', name: 'ada@example.com' } }),
    )
  })

  it('reports an order that could not be saved, and charges nothing', async () => {
    answers.order = { data: null, error: { code: '23514', message: 'check violation' } }
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('closes the order when its line cannot be saved', async () => {
    answers.lineError = { code: '23514', message: 'order_items_renewal_names_domain' }
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('closes the order when Flutterwave cannot be reached', async () => {
    vi.mocked(createPaymentLink).mockRejectedValue(new Error('network'))
    const result = await placeRenewal(INPUT)
    expect(result?.data).toEqual({
      error: expect.stringMatching(/couldn't reach our payment provider/),
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
  })
})
