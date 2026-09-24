import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCartView } from '@/features/cart/queries/cart'
import { deleteLine, findCartId } from '@/features/cart/queries/store'
import { checkAvailability } from '@/features/search/queries/availability'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/features/cart/queries/cart', () => ({ getCartView: vi.fn() }))
vi.mock('@/features/cart/queries/store', () => ({ findCartId: vi.fn(), deleteLine: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
// FR-D4 looks typed nameservers up in public DNS: the network boundary.
vi.mock('@/features/domains/queries/dns', () => ({ lookupHost: async () => 'resolves' }))
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
/** Every update made to an order row — a cancelled order shows up here. */
let orderUpdates: unknown[]
/** Per-test answers for the tables the action reads and writes. */
let answers: {
  tlds: unknown
  settings: unknown
  fxRate: unknown
  order: { data: unknown; error: unknown }
  itemsError: unknown
  preset: { data: unknown; error: unknown }
}
/** Every `nameserver_presets` lookup, as [column, value]. */
let presetLookups: unknown[][]

/** The signed-in user's own client: their saved contact, read and written under RLS. */
function userClient({
  email = 'ada@example.com' as string | null,
  existing = { id: 'contact-1' } as unknown,
  saved = { data: { id: 'contact-1' }, error: null } as unknown,
} = {}) {
  const writes: { op: 'insert' | 'update'; row: unknown }[] = []
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email } } }) },
    from: () => {
      const read = chain({ data: existing, error: null })
      read.insert = (row: unknown) => {
        writes.push({ op: 'insert', row })
        return chain(saved)
      }
      read.update = (row: unknown) => {
        writes.push({ op: 'update', row })
        return chain(saved)
      }
      return read
    },
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return writes
}

type RpcAnswer = { data: unknown; error: { message: string } | null }
let rpcAnswers: Record<string, RpcAnswer> = {}

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

  userClient()
  orderUpdates = []
  answers = {
    tlds: [{ name: 'com', register_usd: 11.31, renew_usd: 11.51, is_country_code: false }],
    settings: { icann_fee_usd: 0.2 },
    fxRate: { id: 'rate-1' },
    order: { data: { id: 'order-1', order_number: 'ND-001001' }, error: null },
    itemsError: null,
    preset: { data: null, error: null },
  }
  presetLookups = []

  rpcAnswers = {
    rate_limit_hit: { data: true, error: null },
    account_domain_allowance: { data: { ordered: 0, max: 20 }, error: null },
  }
  const service = {
    rpc: vi.fn(async (name: string) => {
      const answer = rpcAnswers[name]
      if (!answer) throw new Error(`unexpected rpc ${name}`)
      return answer
    }),
    from: (table: string) => {
      if (table === 'tlds') return chain({ data: answers.tlds })
      if (table === 'pricing_settings') return chain({ data: answers.settings })
      if (table === 'fx_rates') return chain({ data: answers.fxRate })
      if (table === 'nameserver_presets') {
        const node = chain(answers.preset)
        node.eq = (...args: unknown[]) => {
          presetLookups.push(args)
          return node
        }
        return node
      }
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
          insert: async (rows: unknown) => {
            inserted.items.push(rows)
            return { error: answers.itemsError }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  vi.mocked(createServiceClient).mockReturnValue(service as never)
})

describe('placeOrder — nothing is created or charged when a check fails', () => {
  it('pauses an account that keeps trying, before any supplier or payment call (SEC-11)', async () => {
    rpcAnswers.rate_limit_hit = { data: false, error: null }
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/Too many checkout attempts/) })
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(inserted.orders).toEqual([])
  })

  it('refuses when the limit cannot be checked — fails closed', async () => {
    rpcAnswers.rate_limit_hit = { data: null, error: { message: 'db down' } }
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/Too many checkout attempts/) })
    expect(inserted.orders).toEqual([])
  })

  it('caps the domains one account orders in a day (SEC-11)', async () => {
    rpcAnswers.account_domain_allowance = { data: { ordered: 20, max: 20 }, error: null }
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({
      error: expect.stringMatching(/up to 20 domains a day, and this would take you to 21/),
    })
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(inserted.orders).toEqual([])
  })

  it('refuses when the day’s allowance cannot be read', async () => {
    rpcAnswers.account_domain_allowance = { data: null, error: { message: 'db down' } }
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/haven't been charged/) })
    expect(inserted.orders).toEqual([])
  })

  it('refuses an account not on the pre-launch allowlist', async () => {
    // env is read-only by type; the gate reads it at call time.
    const settings = env as { CHECKOUT_ALLOWLIST?: string }
    const before = settings.CHECKOUT_ALLOWLIST
    settings.CHECKOUT_ALLOWLIST = 'owner@example.com'
    try {
      const result = await placeOrder(INPUT)
      expect(result?.data).toEqual({ error: "Checkout isn't open yet. You haven't been charged." })
      expect(inserted.orders).toEqual([])
      expect(createPaymentLink).not.toHaveBeenCalled()
    } finally {
      settings.CHECKOUT_ALLOWLIST = before
    }
  })

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
      expect.objectContaining({
        amountKobo: 1_978_000,
        orderNumber: 'ND-001001',
        // Paidly's shared webhook forwards notices to us by this prefix.
        txRef: expect.stringMatching(/^MDH-[0-9a-f-]{36}$/),
      }),
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

describe('placeOrder — the cart must be ready to buy', () => {
  it('refuses an empty cart', async () => {
    vi.mocked(getCartView).mockResolvedValue({ state: 'empty' })
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: 'Your cart is empty.' })
    expect(inserted.orders).toEqual([])
  })

  it('refuses a cart that cannot be priced right now', async () => {
    vi.mocked(getCartView).mockResolvedValue({ state: 'unpriced' })
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: 'Your cart is empty.' })
  })

  it.each([
    ['a changed price has not been accepted', { needsAcknowledgement: true }],
    ['an extension is no longer sold', { unavailableCount: 1 }],
  ])('refuses when %s (FR-C4)', async (_, change) => {
    vi.mocked(getCartView).mockResolvedValue({
      state: 'ready',
      lines: [LINE],
      totals: { ...TOTALS, ...change },
      vatPct: 7.5,
      lockMinutes: 30,
    } as never)
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/needs a look before checkout/) })
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(inserted.orders).toEqual([])
  })

  it('asks a signed-out visitor to sign in, and does nothing else', async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    } as never)
    const result = await placeOrder(INPUT)
    expect(result?.serverError).toBe('Please sign in to continue.')
    expect(getCartView).not.toHaveBeenCalled()
  })
})

describe('placeOrder — more checks that stop it before money moves', () => {
  it('refuses when the allowance answer is not what it expects — fails closed', async () => {
    rpcAnswers.account_domain_allowance = { data: { ordered: '3', max: 20 }, error: null }
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/couldn't complete checkout/) })
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('names every taken domain, and asks the supplier once per extension', async () => {
    const second = { ...LINE, id: 'line-2', domain: 'paidly.com' }
    vi.mocked(getCartView).mockResolvedValue({
      state: 'ready',
      lines: [LINE, second],
      totals: TOTALS,
      vatPct: 7.5,
      lockMinutes: 30,
    } as never)
    vi.mocked(checkAvailability).mockResolvedValue({
      ok: true,
      results: [
        { name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'registered' },
        { name: 'paidly', tld: 'com', domain: 'paidly.com', status: 'registered' },
      ],
    })
    vi.mocked(findCartId).mockResolvedValue('cart-1')

    const result = await placeOrder(INPUT)

    expect(checkAvailability).toHaveBeenCalledTimes(1)
    expect(checkAvailability).toHaveBeenCalledWith(['getpaid', 'paidly'], ['com'], 'high')
    expect(deleteLine).toHaveBeenCalledTimes(2)
    expect(result?.data).toEqual({
      error: expect.stringMatching(/^getpaid.com, paidly.com were registered by someone else/),
    })
  })

  it('still reports a taken name when the cart row has gone', async () => {
    vi.mocked(checkAvailability).mockResolvedValue({
      ok: true,
      results: [{ name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'registered' }],
    })
    vi.mocked(findCartId).mockResolvedValue(null)
    const result = await placeOrder(INPUT)
    expect(deleteLine).not.toHaveBeenCalled()
    expect(result?.data).toEqual({ error: expect.stringMatching(/registered by someone else/) })
  })

  it('stops when the supplier cost of an extension is unknown, rather than guessing the float', async () => {
    answers.tlds = null
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/Try again in a few minutes/) })
    expect(callGateway).not.toHaveBeenCalled()
    expect(inserted.orders).toEqual([])
  })

  it('stops when the supplier balance comes back in a shape it does not know', async () => {
    vi.mocked(callGateway).mockResolvedValue({ balance: 'lots' })
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ error: expect.stringMatching(/haven't been charged/) })
    expect(inserted.orders).toEqual([])
  })
})

describe('placeOrder — creating the order', () => {
  it('covers the order when there is no ICANN fee setting to add', async () => {
    answers.settings = null
    vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 11.31 })
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders[0]).toMatchObject({ float_check: 'covered' })
  })

  it('updates the saved default contact rather than adding another', async () => {
    const writes = userClient()
    await placeOrder(INPUT)
    expect(writes).toEqual([
      { op: 'update', row: expect.objectContaining({ first_name: 'Ada', is_default: true }) },
    ])
    expect(inserted.orders[0]).toMatchObject({ contact_profile_id: 'contact-1' })
  })

  it('saves the registrant as the default contact the first time', async () => {
    const writes = userClient({ existing: null, saved: { data: { id: 'contact-9' }, error: null } })
    await placeOrder(INPUT)
    expect(writes).toEqual([
      {
        op: 'insert',
        row: expect.objectContaining({
          user_id: 'user-1',
          company: null,
          address_line2: null,
          country: 'NG',
        }),
      },
    ])
    expect(inserted.orders[0]).toMatchObject({ contact_profile_id: 'contact-9' })
  })

  it('still places the order when the contact cannot be saved', async () => {
    userClient({ existing: null, saved: { data: null, error: { message: 'rls', code: '42501' } } })
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders[0]).toMatchObject({ contact_profile_id: null })
  })

  it('charges nothing when the order cannot be written', async () => {
    answers.order = { data: null, error: { message: 'insert failed', code: '23514' } }
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(inserted.items).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('cancels the order, and charges nothing, when its domains cannot be written', async () => {
    answers.itemsError = { message: 'insert failed', code: '23514' }
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('cancels the order it created when Flutterwave cannot be reached', async () => {
    vi.mocked(createPaymentLink).mockRejectedValue(new Error('Flutterwave 503'))
    await placeOrder(INPUT)
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
  })

  it('writes each domain at the price the customer saw, and privacy only where offered', async () => {
    const ccTld = {
      ...LINE,
      id: 'line-2',
      domain: 'getpaid.co',
      tld: 'co',
      privacy: true,
      privacyOffered: false,
    }
    vi.mocked(getCartView).mockResolvedValue({
      state: 'ready',
      lines: [LINE, ccTld],
      totals: TOTALS,
      vatPct: 7.5,
      lockMinutes: 30,
    } as never)
    vi.mocked(checkAvailability).mockImplementation(async (stems, [tld]) => ({
      ok: true,
      results: stems.map((name) => ({
        name,
        tld: tld ?? '',
        domain: `${name}.${tld}`,
        status: 'available' as const,
      })),
    }))
    answers.tlds = [
      { name: 'com', register_usd: 11.31, renew_usd: 11.51, is_country_code: false },
      { name: 'co', register_usd: 19.49, renew_usd: 38.99, is_country_code: true },
    ]

    await placeOrder(INPUT)

    expect(inserted.items[0]).toEqual([
      expect.objectContaining({ domain: 'getpaid.com', privacy: true, price_kobo: 1_840_000 }),
      expect.objectContaining({ domain: 'getpaid.co', privacy: false }),
    ])
  })

  it('gives Flutterwave the registrant’s email when the account has none', async () => {
    userClient({ email: null })
    await placeOrder(INPUT)
    expect(createPaymentLink).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: { email: 'ada@example.com', name: 'Ada Okafor', phone: '+2348031234567' },
        redirectUrl: expect.stringMatching(/\/app\/checkout\/complete\?order=order-1$/),
      }),
    )
  })

  it('refuses, saying nothing was charged, when there is no exchange rate to record', async () => {
    answers.fxRate = null
    const result = await placeOrder(INPUT)
    expect(result?.data).toEqual({
      error: "Prices are unavailable right now. You haven't been charged. Try again shortly.",
    })
    expect(inserted.orders).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })
})

describe('placeOrder — a host preset at checkout (FR-C10, FR-D2, N11)', () => {
  const PRESET_ID = '0d8f4d8e-5a8b-4c43-9a0f-3a6b1d2e7f10'
  const VERCEL = {
    id: PRESET_ID,
    provider: 'Vercel',
    nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
    assigns_per_zone: false,
    verified_at: '2026-09-23T09:00:00Z',
    is_hidden: false,
  }

  /** Nothing moved: no order row, no supplier call, no payment link. */
  function expectNothingStarted() {
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(inserted.orders).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  }

  it('refuses a preset it cannot find, before anything else', async () => {
    const result = await placeOrder({ ...INPUT, presetId: PRESET_ID })
    expect(result?.data).toEqual({
      error: expect.stringMatching(/no longer on our list/),
      field: 'presetId',
    })
    expectNothingStarted()
  })

  it('refuses a hidden preset, even by id', async () => {
    answers.preset = { data: { ...VERCEL, is_hidden: true }, error: null }
    const result = await placeOrder({ ...INPUT, presetId: PRESET_ID })
    expect(result?.data).toMatchObject({ field: 'presetId' })
    expectNothingStarted()
  })

  it('refuses a preset nobody has verified', async () => {
    answers.preset = { data: { ...VERCEL, verified_at: null }, error: null }
    const result = await placeOrder({ ...INPUT, presetId: PRESET_ID })
    expect(result?.data).toMatchObject({ field: 'presetId' })
    expectNothingStarted()
  })

  it('refuses a per-zone provider, and says where to add its nameservers later (FR-D3)', async () => {
    answers.preset = {
      data: { ...VERCEL, provider: 'Cloudflare', nameservers: [], assigns_per_zone: true },
      error: null,
    }
    const result = await placeOrder({ ...INPUT, presetId: PRESET_ID })
    expect(result?.data).toEqual({
      error: expect.stringMatching(/^Cloudflare .+Nameservers tab\.$/),
      field: 'presetId',
    })
    expectNothingStarted()
  })

  it('refuses a preset whose stored nameservers would not validate', async () => {
    answers.preset = { data: { ...VERCEL, nameservers: ['ns1.vercel-dns.com'] }, error: null }
    const result = await placeOrder({ ...INPUT, presetId: PRESET_ID })
    expect(result?.data).toMatchObject({ field: 'presetId' })
    expectNothingStarted()
  })

  it('refuses a preset sent with typed nameservers — one or the other', async () => {
    answers.preset = { data: VERCEL, error: null }
    const result = await placeOrder({
      ...INPUT,
      presetId: PRESET_ID,
      nameservers: 'ns1.evil.example ns2.evil.example',
    })
    expect(result?.data).toEqual({
      error: 'Choose your host or enter nameservers, not both.',
      field: 'presetId',
    })
    expect(presetLookups).toEqual([])
    expectNothingStarted()
  })

  it('charges nothing when the preset cannot be read', async () => {
    answers.preset = { data: null, error: { code: '08006', message: 'connection lost' } }
    const result = await placeOrder({ ...INPUT, presetId: PRESET_ID })
    expect(result?.data).toEqual({
      error: "We couldn't check that host just now. You haven't been charged. Try again shortly.",
      field: 'presetId',
    })
    expectNothingStarted()
  })

  it('refuses a preset id that is not a UUID', async () => {
    const result = await placeOrder({ ...INPUT, presetId: 'vercel' })
    expect(result?.validationErrors).toBeDefined()
    expectNothingStarted()
  })

  it('stores the nameservers our table holds for the preset, with its id', async () => {
    answers.preset = { data: VERCEL, error: null }
    const result = await placeOrder({ ...INPUT, presetId: PRESET_ID, nameservers: '  ' })

    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(presetLookups).toEqual([['id', PRESET_ID]])
    expect(inserted.orders[0]).toMatchObject({
      nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
      nameserver_preset_id: PRESET_ID,
    })
  })

  it('records no preset for typed nameservers, or for the registrar’s default', async () => {
    await placeOrder({ ...INPUT, nameservers: 'ns1.host.com ns2.host.com', presetId: null })
    await placeOrder(INPUT)
    expect(inserted.orders).toEqual([
      expect.objectContaining({
        nameservers: ['ns1.host.com', 'ns2.host.com'],
        nameserver_preset_id: null,
      }),
      expect.objectContaining({ nameservers: null, nameserver_preset_id: null }),
    ])
    expect(presetLookups).toEqual([])
  })
})
