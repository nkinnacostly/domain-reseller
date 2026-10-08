import { userMessageFor } from '@dr/shared'
import { after } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
// The lines' costs (ADMIN-SPEC §6) are written after the response: queued here.
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: vi.fn(),
}))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/flutterwave', () => ({ createPaymentLink: vi.fn() }))
vi.mock('@/lib/gateway', () => ({ callGateway: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))
// The account-wide rule hook for bulk renewal: stood in for so a refusal can be tested.
const guard = vi.hoisted(() => ({ answer: null as { error: string } | null }))
vi.mock('../queries/renewal-guard', () => ({ guardBulkRenewal: async () => guard.answer }))

const { placeRenewals } = await import('../actions/place-renewals')

const COM_ID = '4f5d3c1a-7b2e-4c8d-9a6f-1e2b3c4d5e6f'
const NG_ID = '5a6b7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'
const COM_KOBO = 1_870_000
const NG_KOBO = 1_050_000
/** Two years of each, plus 7.5% VAT on the subtotal. */
const TWO_YEARS = {
  com: 3_740_000,
  ng: 2_100_000,
  subtotal: 5_840_000,
  vat: 438_000,
  total: 6_278_000,
}
const INPUT = { domainIds: [NG_ID, COM_ID], years: 2, expectedTotalKobo: TWO_YEARS.total }

const ADA = {
  firstName: 'Ada',
  lastName: 'Okafor',
  email: 'ada@example.com',
  phone: '8031234567',
  phoneCountryCode: '234',
}
const inAYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString()
const domain = (id: string, name: string, tld: string, overrides = {}) => ({
  id,
  domain_name: name,
  tld,
  source: 'registration',
  test_mode: true,
  local_status: 'active',
  expires_at: inAYear(),
  auto_renew: true,
  privacy_enabled: false,
  registrant: ADA,
  ...overrides,
})

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
  domains: { data: unknown; error: unknown }
  open: { data: unknown; error: unknown }
  costs: unknown
  settings: unknown
  fxRate: unknown
  order: { data: unknown; error: unknown }
  lineError: unknown
  defaultContact: unknown
}
let inserted: { orders: unknown[]; items: unknown[]; itemOptions: unknown[]; costs: unknown[] }
let orderUpdates: unknown[]
let rateLimited: { data: unknown; error: unknown }
let costsAnswer: () => Promise<{ error: unknown }>

/** What `after` was handed, run as Next would once the response has gone. */
async function afterResponse() {
  for (const [task] of vi.mocked(after).mock.calls) await (task as () => Promise<void>)()
}

beforeEach(() => {
  vi.clearAllMocks()
  guard.answer = null
  inserted = { orders: [], items: [], itemOptions: [], costs: [] }
  costsAnswer = async () => ({ error: null })
  vi.mocked(after).mockImplementation(() => undefined)
  orderUpdates = []
  rateLimited = { data: true, error: null }
  answers = {
    domains: {
      data: [domain(NG_ID, 'naija.ng', 'ng'), domain(COM_ID, 'getpaid.com', 'com')],
      error: null,
    },
    open: { data: [], error: null },
    costs: [
      { name: 'com', renew_usd: 11.51, is_country_code: false },
      { name: 'ng', renew_usd: 6.5, is_country_code: true },
    ],
    settings: { icann_fee_usd: 0.2 },
    fxRate: { id: 'rate-1' },
    order: { data: { id: 'order-1', order_number: 'ND-001001' }, error: null },
    lineError: null,
    defaultContact: null,
  }

  vi.mocked(requirePaymentEnv).mockReturnValue({
    secretKey: 'FLWSECK_TEST-x-X',
    publicKey: 'FLWPUBK_TEST-x-X',
    webhookHash: 'hash',
    testMode: true,
  })
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    vatPct: 7.5,
    tlds: [
      {
        tld: 'com',
        maxPeriod: 10,
        renewPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        renewal: { priceKobo: COM_KOBO },
        renewalTerm: { years: 1, priceKobo: COM_KOBO },
      },
      {
        tld: 'ng',
        maxPeriod: 10,
        renewPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        renewal: { priceKobo: NG_KOBO },
        renewalTerm: { years: 1, priceKobo: NG_KOBO },
      },
    ],
  } as never)
  vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 500 })
  vi.mocked(createPaymentLink).mockResolvedValue('https://checkout.test/pay/1')

  // The customer's own client (RLS): their domains, open renewals, and details.
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
          error: null,
        }),
      },
    },
    from: (table: string) => {
      if (table === 'domains') return chain(answers.domains)
      if (table === 'order_items') return chain(answers.open)
      if (table === 'contact_profiles') return chain({ data: answers.defaultContact })
      if (table === 'profiles') return chain({ data: { full_name: 'Ada Okafor', phone: null } })
      throw new Error(`unexpected user table ${table}`)
    },
  } as never)

  vi.mocked(createServiceClient).mockReturnValue({
    rpc: vi.fn(async (name: string) => {
      if (name === 'rate_limit_hit') return rateLimited
      throw new Error(`unexpected rpc ${name}`)
    }),
    from: (table: string) => {
      if (table === 'tlds') return chain({ data: answers.costs })
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
          insert: async (rows: unknown, options?: unknown) => {
            inserted.items.push(rows)
            inserted.itemOptions.push(options)
            return { error: answers.lineError }
          },
        }
      }
      if (table === 'order_item_costs') {
        return {
          insert: async (rows: unknown) => {
            inserted.costs.push(rows)
            return costsAnswer()
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

describe('placeRenewals — nothing is created or charged when a check fails', () => {
  it('stops at the account guard before anything is read or priced', async () => {
    guard.answer = { error: "Renewals are paused on this account. You haven't been charged." }
    expect((await placeRenewals(INPUT))?.data).toEqual(guard.answer)
    expect(getPricedCatalogue).not.toHaveBeenCalled()
    expect(callGateway).not.toHaveBeenCalled()
    nothingCreated()
  })

  it('refuses an account not on the pre-launch allowlist', async () => {
    const settings = env as { CHECKOUT_ALLOWLIST?: string }
    const before = settings.CHECKOUT_ALLOWLIST
    settings.CHECKOUT_ALLOWLIST = 'owner@example.com'
    try {
      expect((await placeRenewals(INPUT))?.data).toEqual({
        error: "Payments aren't open yet. You haven't been charged.",
      })
      nothingCreated()
    } finally {
      settings.CHECKOUT_ALLOWLIST = before
    }
  })

  it('pauses an account that keeps trying, and fails closed', async () => {
    rateLimited = { data: null, error: { message: 'db down' } }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^Too many attempts/),
    })
    nothingCreated()
  })

  it('takes at most 100 domains in one order', async () => {
    const many = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    )
    expect((await placeRenewals({ ...INPUT, domainIds: many }))?.validationErrors).toBeDefined()
    nothingCreated()
  })

  it('refuses when the domains cannot be read — fails closed', async () => {
    answers.domains = { data: null, error: { code: '500', message: 'db down' } }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't complete this just now/),
    })
    nothingCreated()
  })

  it('refuses the whole order when any domain is not the account’s (RLS)', async () => {
    answers.domains = { data: [domain(COM_ID, 'getpaid.com', 'com')], error: null }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^Some of those domains aren't on your account/),
    })
    nothingCreated()
  })

  it('refuses when open renewals cannot be read — fails closed', async () => {
    answers.open = { data: null, error: { code: '500', message: 'db down' } }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't complete this just now/),
    })
    nothingCreated()
  })

  it('names the domain already being renewed', async () => {
    answers.open = { data: [{ domain_id: NG_ID, status: 'provisioning' }], error: null }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error:
        "naija.ng: A renewal of this domain is already paid for and being made. You haven't been charged.",
    })
    nothingCreated()
  })

  it('withholds the order without prices (N5b)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null as never)
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/Renewal prices are unavailable/),
    })
    vi.mocked(getPricedCatalogue).mockResolvedValue({
      vatPct: 7.5,
      tlds: [
        {
          tld: 'com',
          maxPeriod: 10,
          renewPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          renewal: { priceKobo: COM_KOBO },
          renewalTerm: { years: 1, priceKobo: COM_KOBO },
        },
      ],
    } as never)
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^naija\.ng: renewal prices for \.ng are unavailable/),
    })
    nothingCreated()
  })

  it('names a domain the one-domain rules would refuse', async () => {
    answers.domains = {
      data: [
        domain(NG_ID, 'naija.ng', 'ng', { source: 'demo' }),
        domain(COM_ID, 'getpaid.com', 'com'),
      ],
      error: null,
    }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: "naija.ng: Demo domains can’t be renewed. You haven't been charged.",
    })
    nothingCreated()
  })

  it('names a domain that cannot take that many years', async () => {
    answers.domains = {
      data: [
        domain(NG_ID, 'naija.ng', 'ng', {
          expires_at: new Date(Date.now() + 9 * 365 * 86_400_000).toISOString(),
        }),
        domain(COM_ID, 'getpaid.com', 'com'),
      ],
      error: null,
    }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^naija\.ng can be renewed for at most 1 year now/),
    })
    nothingCreated()
  })

  it('refuses when the total moved since the page loaded (FR-C4)', async () => {
    expect(
      (await placeRenewals({ ...INPUT, expectedTotalKobo: TWO_YEARS.total - 1 }))?.data,
    ).toEqual({ error: expect.stringMatching(/renewal price has changed/) })
    nothingCreated()
  })

  it('refuses when a supplier cost or the rate is missing', async () => {
    answers.costs = [{ name: 'com', renew_usd: 11.51, is_country_code: false }]
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/Renewal prices are unavailable/),
    })
    answers.costs = []
    answers.fxRate = null
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/Renewal prices are unavailable/),
    })
    nothingCreated()
  })

  it('refuses when the supplier balance cannot be read', async () => {
    vi.mocked(callGateway).mockRejectedValue(new Error('gateway down'))
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't complete this just now/),
    })
    nothingCreated()
  })

  it('never takes a live payment the float cannot cover — for all the domains (I3)', async () => {
    vi.mocked(requirePaymentEnv).mockReturnValue({
      secretKey: 'FLWSECK-live-X',
      publicKey: 'FLWPUBK-live-X',
      webhookHash: 'hash',
      testMode: false,
    })
    answers.domains = {
      data: [
        domain(NG_ID, 'naija.ng', 'ng', { test_mode: false }),
        domain(COM_ID, 'getpaid.com', 'com', { test_mode: false }),
      ],
      error: null,
    }
    // Two years of .com (11.71) and .ng (6.50) is 36.42; one alone would fit in 30.
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 30 })
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: userMessageFor('SUPPLIER_INSUFFICIENT_FUNDS'),
    })
    nothingCreated()
  })
})

describe('placeRenewals — the order and the payment', () => {
  it('creates one order with a line per domain, each priced alone, and pays once', async () => {
    const result = await placeRenewals(INPUT)

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
        registrant: ADA,
        float_check: 'covered',
        test_mode: true,
      }),
    ])
    // A line that leaves out renewal_years (NOT NULL) takes its default, not NULL.
    expect(inserted.itemOptions).toEqual([{ defaultToNull: false }])
    // By name, each with its own price and its renewal price (N8).
    expect(inserted.items).toEqual([
      [
        {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          order_id: 'order-1',
          item_type: 'renew',
          domain_id: COM_ID,
          domain: 'getpaid.com',
          tld: 'com',
          period_years: 2,
          privacy: false,
          auto_renew: true,
          price_kobo: TWO_YEARS.com,
          renewal_kobo: COM_KOBO,
        },
        {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          order_id: 'order-1',
          item_type: 'renew',
          domain_id: NG_ID,
          domain: 'naija.ng',
          tld: 'ng',
          period_years: 2,
          privacy: false,
          auto_renew: true,
          price_kobo: TWO_YEARS.ng,
          renewal_kobo: NG_KOBO,
        },
      ],
    ])
    expect(createPaymentLink).toHaveBeenCalledWith({
      txRef: expect.stringMatching(/^MDH-/),
      amountKobo: TWO_YEARS.total,
      redirectUrl: expect.stringMatching(/\/app\/checkout\/complete\?order=order-1$/),
      customer: { email: 'ada@example.com', name: 'Ada Okafor', phone: '+2348031234567' },
      orderNumber: 'ND-001001',
    })
  })

  it('records the account’s own details when the domains have different registrants', async () => {
    answers.domains = {
      data: [
        domain(NG_ID, 'naija.ng', 'ng', { registrant: { ...ADA, firstName: 'Chidi' } }),
        domain(COM_ID, 'getpaid.com', 'com'),
      ],
      error: null,
    }
    await placeRenewals(INPUT)
    expect(inserted.orders).toEqual([
      expect.objectContaining({
        registrant: expect.objectContaining({ firstName: 'Ada', lastName: 'Okafor' }),
      }),
    ])
    expect(createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({ customer: { email: 'ada@example.com', name: 'Ada Okafor' } }),
    )
  })

  it('records a test-mode float shortfall and lets the test payment through', async () => {
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 0 })
    expect((await placeRenewals(INPUT))?.data).toEqual({
      redirectTo: 'https://checkout.test/pay/1',
    })
    expect(inserted.orders).toEqual([
      expect.objectContaining({ float_check: 'shortfall_test_mode' }),
    ])
  })

  it('reports an order that could not be saved, and charges nothing', async () => {
    answers.order = { data: null, error: { code: '23514', message: 'check violation' } }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('closes the order when its lines cannot be saved', async () => {
    answers.lineError = { code: '23514', message: 'order_items_renewal_names_domain' }
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('closes the order when Flutterwave cannot be reached', async () => {
    vi.mocked(createPaymentLink).mockRejectedValue(new Error('network'))
    expect((await placeRenewals(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't reach our payment provider/),
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
  })
})

describe('placeRenewals — what each line cost us (ADMIN-SPEC §6, D13)', () => {
  beforeEach(() => {
    // As PostgREST answers `::text`: the database's own decimal digits.
    answers.costs = [
      { name: 'com', renew_usd: '11.5100', is_country_code: false },
      { name: 'ng', renew_usd: '6.5000', is_country_code: true },
    ]
    answers.settings = { icann_fee_usd: '0.2000' }
  })

  it('records each line, ICANN apart, adding up to the float check to the cent', async () => {
    // .com: two years at $11.51 and $0.20 ICANN a year; .ng: two at $6.50. $36.42.
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 36.42 })
    await placeRenewals(INPUT)
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 36.41 })
    await placeRenewals(INPUT)
    expect(inserted.orders).toEqual([
      expect.objectContaining({ float_check: 'covered' }),
      expect.objectContaining({ float_check: 'shortfall_test_mode' }),
    ])
    expect(inserted.costs).toEqual([])
    await afterResponse()
    const ids = (inserted.items[0] as { id: string; domain: string }[]).map((row) => row.id)
    expect(inserted.costs[0]).toEqual([
      { order_item_id: ids[0], supplier_cost_cents: 2302, icann_fee_cents: 40 },
      { order_item_id: ids[1], supplier_cost_cents: 1300, icann_fee_cents: 0 },
    ])
  })

  it('keeps the order as it was when the costs cannot be recorded, logging the order id only', async () => {
    const error = vi.spyOn(logger, 'error')
    costsAnswer = () => Promise.reject(new Error('fetch failed'))
    expect((await placeRenewals(INPUT))?.data).toEqual({
      redirectTo: 'https://checkout.test/pay/1',
    })
    await expect(afterResponse()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      { orderId: 'order-1', code: undefined },
      'line costs not recorded',
    )
    expect(orderUpdates).toEqual([])
    error.mockRestore()
  })

  it('records nothing when the lines were never written', async () => {
    answers.lineError = { code: '23514', message: 'order_items_renewal_names_domain' }
    await placeRenewals(INPUT)
    expect(after).not.toHaveBeenCalled()
  })
})
