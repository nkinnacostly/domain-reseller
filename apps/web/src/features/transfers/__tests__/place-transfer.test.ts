import { GatewayError, userMessageFor } from '@dr/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import type { RdapLookup } from '../lib/rdap'
import { lookupDomain } from '../queries/rdap-lookup'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/flutterwave', () => ({ createPaymentLink: vi.fn() }))
vi.mock('@/lib/gateway', () => ({ callGateway: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('../queries/rdap-lookup', () => ({ lookupDomain: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))

const { placeTransfer } = await import('../actions/place-transfer')

const CODE = 'Xk9#-transfer-CODE'
const TRANSFER_KOBO = 1_700_000
const RENEWAL_KOBO = 1_870_000
/** The transfer price plus 7.5% VAT. */
const TOTAL = TRANSFER_KOBO + 127_500

const REGISTRANT = {
  firstName: 'Ada',
  lastName: 'Okafor',
  company: '',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '0803 123 4567',
  addressLine1: '1 Marina',
  addressLine2: '',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const INPUT = {
  domain: 'GetPaid.com',
  authCode: CODE,
  registrant: REGISTRANT,
  expectedTotalKobo: TOTAL,
}

const found = (over: Record<string, unknown> = {}): RdapLookup => ({
  kind: 'found',
  record: {
    statuses: ['active'],
    registeredAt: '2015-03-01T10:00:00.000Z',
    lastTransferredAt: null,
    expiresAt: '2027-03-01T10:00:00.000Z',
    registrar: 'Example Registrar Ltd',
    ...over,
  },
})

/** A chainable double: a real promise, with the query methods the action calls. */
function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'neq', 'not', 'in', 'limit', 'order', 'update']) {
    node[method] = () => node
  }
  node.single = async () => result
  node.maybeSingle = async () => result
  return node
}

let answers: {
  tld: unknown
  domains: { data: unknown; error: unknown }
  settings: unknown
  fxRate: unknown
  order: { data: unknown; error: unknown }
  line: { data: unknown; error: unknown }
  secretError: unknown
  check: unknown
  balance: unknown
}
let inserted: { orders: unknown[]; items: unknown[]; secrets: unknown[] }
let orderUpdates: unknown[]
let secretDeletes: unknown[]
let limits: Record<string, { data: unknown; error: unknown }>
let limitKeys: string[]
/** account_domain_allowance(), and what it was asked. */
let allowance: { data: unknown; error: unknown }
let allowanceArgs: unknown[]
/** FR-A2: the domains the account holds (as the user), and its authenticators. */
let held: { count: number | null; error: unknown }
let factors: { data: unknown; error: unknown }

/** account_domain_allowance() for an established account (migration 32). */
const established = (over: Record<string, unknown> = {}) => ({
  ordered: 0,
  max: 20,
  tier: 'standard',
  paid_orders: 1,
  account_days: 12,
  standard_after_days: 7,
  trusted_after_days: 30,
  trusted_after_paid_orders: 3,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  inserted = { orders: [], items: [], secrets: [] }
  orderUpdates = []
  secretDeletes = []
  limits = {}
  limitKeys = []
  allowance = { data: established(), error: null }
  allowanceArgs = []
  held = { count: 1, error: null }
  factors = { data: { totp: [] }, error: null }
  answers = {
    tld: { transfer_usd: 10.61, is_country_code: false, is_transferable: true },
    domains: { data: [], error: null },
    settings: { icann_fee_usd: 0.2 },
    fxRate: { id: 'rate-1' },
    order: { data: { id: 'order-1', order_number: 'ND-001001' }, error: null },
    line: { data: { id: 'line-1' }, error: null },
    secretError: null,
    check: { transferable: true },
    balance: { balanceUsd: 500 },
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
        isCountryCode: false,
        transfer: { priceKobo: TRANSFER_KOBO },
        renewal: { priceKobo: RENEWAL_KOBO },
      },
    ],
  } as never)
  vi.mocked(lookupDomain).mockResolvedValue(found())
  vi.mocked(callGateway).mockImplementation(async ({ path }) => {
    if (path === 'transfers/check') return answers.check
    if (path === 'account/balance') return answers.balance
    throw new Error(`unexpected gateway path ${path}`)
  })
  vi.mocked(createPaymentLink).mockResolvedValue('https://checkout.test/pay/1')

  // The customer's own client (RLS): their default contact.
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } }),
      mfa: { listFactors: async () => factors },
    },
    from: (table: string) => {
      if (table === 'domains') return chain(held)
      if (table === 'contact_profiles') {
        const node = chain({ data: null, error: null })
        node.insert = () => chain({ data: { id: 'contact-1' }, error: null })
        return node
      }
      throw new Error(`unexpected user table ${table}`)
    },
  } as never)

  vi.mocked(createServiceClient).mockReturnValue({
    rpc: vi.fn(async (name: string, args: { p_key: string }) => {
      if (name === 'account_domain_allowance') {
        allowanceArgs.push(args)
        return allowance
      }
      if (name !== 'rate_limit_hit') throw new Error(`unexpected rpc ${name}`)
      limitKeys.push(args.p_key)
      const key = Object.keys(limits).find((prefix) => args.p_key.startsWith(prefix))
      return key ? limits[key] : { data: true, error: null }
    }),
    from: (table: string) => {
      if (table === 'tlds') return chain({ data: answers.tld })
      if (table === 'domains') return chain(answers.domains)
      if (table === 'pricing_settings') return chain({ data: answers.settings })
      if (table === 'fx_rates') return chain({ data: answers.fxRate })
      if (table === 'orders') {
        const node = chain(answers.order)
        node.insert = (row: unknown) => {
          inserted.orders.push(row)
          return chain(answers.order)
        }
        node.update = (patch: unknown) => {
          orderUpdates.push(patch)
          return chain({ error: null })
        }
        return node
      }
      if (table === 'order_items') {
        return {
          insert: (row: unknown) => {
            inserted.items.push(row)
            return chain(answers.line)
          },
        }
      }
      if (table === 'transfer_secrets') {
        return {
          insert: async (row: unknown) => {
            inserted.secrets.push(row)
            return { error: answers.secretError }
          },
          delete: () => ({
            eq: async (_column: string, value: unknown) => {
              secretDeletes.push(value)
              return { error: null }
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never)
})

const nothingCreated = () => {
  expect(inserted.orders).toEqual([])
  expect(inserted.secrets).toEqual([])
  expect(createPaymentLink).not.toHaveBeenCalled()
}
const codeNotChecked = () =>
  expect(callGateway).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'transfers/check' }))

describe('placeTransfer — nothing is created or charged when a check fails', () => {
  it('refuses an account not on the pre-launch allowlist', async () => {
    const settings = env as { CHECKOUT_ALLOWLIST?: string }
    const before = settings.CHECKOUT_ALLOWLIST
    settings.CHECKOUT_ALLOWLIST = 'owner@example.com'
    try {
      expect((await placeTransfer(INPUT))?.data).toEqual({
        error: "Payments aren't open yet. You haven't been charged.",
      })
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
      limits = { place_order: answer }
      expect((await placeTransfer(INPUT))?.data).toEqual({
        error: expect.stringMatching(/^Too many attempts/),
      })
    }
    expect(callGateway).not.toHaveBeenCalled()
    nothingCreated()
  })

  it('refuses what is not a domain', async () => {
    expect((await placeTransfer({ ...INPUT, domain: 'getpaid' }))?.data).toEqual({
      error: 'Include the extension — for example getpaid.com, not just getpaid.',
    })
    nothingCreated()
  })

  it('withholds a transfer without prices (N5b)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null as never)
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^Prices are unavailable/),
    })
    nothingCreated()
  })

  it('refuses an extension without a transfer price, or that the catalogue has not cleared', async () => {
    for (const tld of [
      { transfer_usd: 10.61, is_country_code: false, is_transferable: null },
      { transfer_usd: 10.61, is_country_code: false, is_transferable: false },
      { transfer_usd: 0, is_country_code: false, is_transferable: true },
      null,
    ]) {
      answers.tld = tld
      expect((await placeTransfer(INPUT))?.data).toEqual({
        error: "We don’t take transfers for .com yet. You haven't been charged.",
      })
    }
    vi.mocked(getPricedCatalogue).mockResolvedValue({
      vatPct: 7.5,
      tlds: [{ tld: 'com', transfer: null, renewal: { priceKobo: RENEWAL_KOBO } }],
    } as never)
    answers.tld = { transfer_usd: 10.61, is_country_code: false, is_transferable: true }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/We don’t take transfers for \.com yet/),
    })
    nothingCreated()
  })

  it('fails closed when it cannot tell whether the name is here already', async () => {
    answers.domains = { data: null, error: { code: '500', message: 'db down' } }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't complete this just now/),
    })
    nothingCreated()
  })

  it('refuses a name already on the account, held by another account here, or already moving', async () => {
    answers.domains = { data: [{ user_id: 'user-1', local_status: 'active' }], error: null }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: "getpaid.com is already on your account. You haven't been charged.",
    })
    answers.domains = { data: [{ user_id: 'user-2', local_status: 'expired_grace' }], error: null }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/already registered with us, so it can’t be transferred in/),
    })
    answers.domains = {
      data: [{ user_id: 'user-1', local_status: 'transfer_pending' }],
      error: null,
    }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/already paid for and under way/),
    })
    codeNotChecked()
    nothingCreated()
  })

  it('counts a transfer against the daily cap, before the registry or the supplier is asked (SEC-11)', async () => {
    allowance = {
      data: established({ tier: 'new', max: 5, ordered: 5, paid_orders: 0, account_days: 1 }),
      error: null,
    }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error:
        "New accounts can order up to 5 domains a day, transfers in included, and you have ordered 5 in the last 24 hours. That rises after your first paid order, or once your account is a week old. You haven't been charged. Each order stops counting 24 hours after it was placed, so try again later, or email hello@mydomainshub.com to raise your limit.",
    })
    expect(allowanceArgs).toEqual([{ p_user_id: 'user-1', p_test_mode: true }])
    expect(lookupDomain).not.toHaveBeenCalled()
    codeNotChecked()
    nothingCreated()
  })

  it('lets a transfer land exactly on the cap', async () => {
    allowance = { data: established({ ordered: 19 }), error: null }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      redirectTo: 'https://checkout.test/pay/1',
    })
  })

  it('counts a live transfer against live orders only', async () => {
    vi.mocked(requirePaymentEnv).mockReturnValue({
      secretKey: 'FLWSECK-x-X',
      publicKey: 'FLWPUBK-x-X',
      webhookHash: 'hash',
      testMode: false,
    })
    await placeTransfer(INPUT)
    expect(allowanceArgs).toEqual([{ p_user_id: 'user-1', p_test_mode: false }])
  })

  it('fails closed when the daily cap cannot be read, or reads wrongly', async () => {
    for (const answer of [
      { data: null, error: { message: 'db down' } },
      { data: { ordered: 0, max: 20 }, error: null },
    ]) {
      allowance = answer
      expect((await placeTransfer(INPUT))?.data).toEqual({
        error: "We couldn't complete this just now. You haven't been charged. Try again shortly.",
      })
    }
    codeNotChecked()
    nothingCreated()
  })

  it('refuses an account holding more than ten domains until two-factor is on (FR-A2)', async () => {
    held = { count: 11, error: null }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error:
        "Accounts holding more than 10 domains need two-factor authentication before transferring more domains in. You haven't been charged. Turn it on in Settings, under Two-factor authentication, then try again.",
      twoFactor: true,
    })
    expect(limitKeys).toEqual([])
    expect(lookupDomain).not.toHaveBeenCalled()
    codeNotChecked()
    nothingCreated()

    factors = { data: { totp: [{ status: 'verified' }] }, error: null }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      redirectTo: 'https://checkout.test/pay/1',
    })
  })

  it('fails closed when the two-factor rule cannot be checked', async () => {
    for (const [count, answer] of [
      [{ count: null, error: { message: 'db down' } }, factors],
      [
        { count: 11, error: null },
        { data: null, error: { message: 'auth down' } },
      ],
    ] as const) {
      held = count as typeof held
      factors = answer
      expect((await placeTransfer(INPUT))?.data).toEqual({
        error: "We couldn't complete this just now. You haven't been charged. Try again shortly.",
      })
    }
    nothingCreated()
  })

  it('refuses what the registry shows cannot move, with the reason and the date (FR-T7)', async () => {
    vi.mocked(lookupDomain).mockResolvedValue(found({ registeredAt: '2099-01-01T00:00:00.000Z' }))
    const result = await placeTransfer(INPUT)
    expect(result?.data).toEqual({
      error: expect.stringMatching(/^getpaid\.com can’t be transferred yet\. It was registered on/),
    })
    codeNotChecked()
    nothingCreated()
  })

  it('refuses when the total moved since the page loaded (FR-C4)', async () => {
    expect((await placeTransfer({ ...INPUT, expectedTotalKobo: TOTAL - 1 }))?.data).toEqual({
      error: expect.stringMatching(/transfer price has changed/),
    })
    codeNotChecked()
    nothingCreated()
  })

  it('stops guesses at a code: each domain gets a few checks an hour', async () => {
    limits = { 'transfer_check:': { data: false, error: null } }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^Too many transfer codes have been tried for getpaid\.com/),
    })
    expect(limitKeys).toContain('transfer_check:getpaid.com')
    codeNotChecked()
    nothingCreated()
  })

  it('refuses a code the supplier does not accept — before any payment (N4)', async () => {
    for (const [reason, words] of [
      ['AUTH_CODE_INVALID', /didn’t accept that transfer code/],
      ['TRANSFER_LOCKED', /locked at its current registrar/],
      ['NOT_TRANSFERABLE', /won’t let this domain move/],
    ] as const) {
      answers.check = { transferable: false, reason }
      const result = await placeTransfer(INPUT)
      expect(result?.data).toEqual({ error: expect.stringMatching(words), field: 'authCode' })
    }
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'account/balance' }),
    )
    nothingCreated()
  })

  it('refuses when the code cannot be checked, never paying on a guess', async () => {
    vi.mocked(callGateway).mockRejectedValueOnce(
      new GatewayError('TRANSFERS_UNAVAILABLE', 'wrong side', { retryable: false }),
    )
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^Transfers can’t be started right now/),
    })
    vi.mocked(callGateway).mockRejectedValueOnce(new GatewayError('SUPPLIER_UNAVAILABLE', 'x'))
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't check the transfer code just now/),
    })
    answers.check = { transferable: 'maybe' }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't check the transfer code just now/),
    })
    nothingCreated()
  })

  it('refuses without an active exchange rate, or a readable float', async () => {
    answers.fxRate = null
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/^Prices are unavailable/),
    })
    answers.fxRate = { id: 'rate-1' }
    answers.balance = { nonsense: true }
    expect((await placeTransfer(INPUT))?.data).toEqual({
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
    answers.balance = { balanceUsd: 10 }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: userMessageFor('SUPPLIER_INSUFFICIENT_FUNDS'),
    })
    nothingCreated()
  })
})

describe('placeTransfer — the order, the code and the payment', () => {
  it('checks the code on the order’s side, then creates the order, its line and its code', async () => {
    const result = await placeTransfer(INPUT)

    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'transfers/check',
        body: { domainName: 'getpaid.com', authCode: CODE, testMode: true },
      }),
    )
    expect(inserted.orders).toEqual([
      expect.objectContaining({
        user_id: 'user-1',
        subtotal_kobo: TRANSFER_KOBO,
        vat_pct: 7.5,
        vat_kobo: 127_500,
        total_kobo: TOTAL,
        fx_rate_id: 'rate-1',
        tx_ref: expect.stringMatching(/^MDH-/),
        registrant: expect.objectContaining({ firstName: 'Ada', phone: '8031234567' }),
        contact_profile_id: 'contact-1',
        float_check: 'covered',
        test_mode: true,
      }),
    ])
    expect(inserted.items).toEqual([
      {
        order_id: 'order-1',
        item_type: 'transfer',
        domain: 'getpaid.com',
        tld: 'com',
        period_years: 1,
        privacy: false,
        auto_renew: true,
        price_kobo: TRANSFER_KOBO,
        renewal_kobo: RENEWAL_KOBO,
      },
    ])
    expect(inserted.secrets).toEqual([{ order_item_id: 'line-1', auth_code: CODE }])
    expect(createPaymentLink).toHaveBeenCalledWith({
      txRef: expect.stringMatching(/^MDH-/),
      amountKobo: TOTAL,
      redirectUrl: expect.stringMatching(/\/app\/checkout\/complete\?order=order-1$/),
      customer: { email: 'ada@example.com', name: 'Ada Okafor', phone: '+2348031234567' },
      orderNumber: 'ND-001001',
    })
  })

  it('lets a registry that cannot be read through — the code check is the final word', async () => {
    vi.mocked(lookupDomain).mockResolvedValue({ kind: 'unavailable' })
    expect((await placeTransfer(INPUT))?.data).toEqual({
      redirectTo: 'https://checkout.test/pay/1',
    })
  })

  it('records a test-mode float shortfall and lets the test payment through', async () => {
    answers.balance = { balanceUsd: 0 }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      redirectTo: 'https://checkout.test/pay/1',
    })
    expect(inserted.orders).toEqual([
      expect.objectContaining({ float_check: 'shortfall_test_mode' }),
    ])
  })

  it('reports an order that could not be saved, and stores no code', async () => {
    answers.order = { data: null, error: { code: '23514', message: 'check violation' } }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(inserted.secrets).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('closes the order when its line cannot be saved', async () => {
    answers.line = { data: null, error: { code: '23514', message: 'order_items_item_type_check' } }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
    expect(inserted.secrets).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('closes the order, and takes the code back out, when the code cannot be stored', async () => {
    answers.secretError = { code: '23514', message: 'transfer_secrets_auth_code_check' }
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: "We couldn't create your order. You haven't been charged.",
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
    expect(secretDeletes).toEqual(['line-1'])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('closes the order and deletes the code when Flutterwave cannot be reached', async () => {
    vi.mocked(createPaymentLink).mockRejectedValue(new Error('network'))
    expect((await placeTransfer(INPUT))?.data).toEqual({
      error: expect.stringMatching(/couldn't reach our payment provider/),
    })
    expect(orderUpdates).toEqual([{ status: 'cancelled' }])
    expect(secretDeletes).toEqual(['line-1'])
  })

  it('never puts the transfer code in a log line (N13)', async () => {
    const spies = [vi.spyOn(logger, 'info'), vi.spyOn(logger, 'warn'), vi.spyOn(logger, 'error')]
    answers.secretError = { code: '23514', message: 'bad' }
    await placeTransfer(INPUT)
    answers.check = { transferable: false, reason: 'AUTH_CODE_INVALID' }
    await placeTransfer(INPUT)
    vi.mocked(callGateway).mockRejectedValueOnce(new GatewayError('SUPPLIER_UNAVAILABLE', 'x'))
    await placeTransfer(INPUT)
    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls))
    expect(logged).not.toContain(CODE)
    for (const spy of spies) spy.mockRestore()
  })
})
