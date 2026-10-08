import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCartView } from '@/features/cart/queries/cart'
import { lookupHost } from '@/features/domains/queries/dns'
import { checkAvailability } from '@/features/search/queries/availability'
import { requirePaymentEnv } from '@/lib/env'
import { createPaymentLink } from '@/lib/flutterwave'
import { callGateway } from '@/lib/gateway'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * placeOrder with a host per domain (FR-C10) and FR-D4's DNS checks, before
 * any money moves. The network boundaries are mocked: the cart, the supplier,
 * Flutterwave, public DNS and the database.
 */

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/features/cart/queries/cart', () => ({ getCartView: vi.fn() }))
vi.mock('@/features/cart/queries/store', () => ({ findCartId: vi.fn(), deleteLine: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('@/features/domains/queries/dns', () => ({ lookupHost: vi.fn() }))
vi.mock('@/lib/flutterwave', () => ({ createPaymentLink: vi.fn() }))
vi.mock('@/lib/gateway', () => ({ callGateway: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))

const { placeOrder } = await import('../actions/place-order')

const HOSTINGER_ID = 'd97320b5-50a9-44d4-a881-7b4bc1a5e077'
const HOSTINGER = {
  id: HOSTINGER_ID,
  provider: 'Hostinger',
  nameservers: ['ns1.dns-parking.com', 'ns2.dns-parking.com'],
  assigns_per_zone: false,
  verified_at: '2026-09-23T09:00:00Z',
  is_hidden: false,
}
const line = (id: string, domain: string) => ({
  id,
  domain,
  tld: 'com',
  periodYears: 1,
  privacy: true,
  autoRenew: true,
  privacyOffered: true,
  payableKobo: 1_840_000,
  renewalKobo: 1_870_000,
  // A one-year extension, sold every year from 1 to 10 (FR-C2).
  status: 'current',
  minPeriod: 1,
  registerPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  unsoldYears: null,
  renewYears: 1,
})
const LINES = [line('line-1', 'getpaid.com'), line('line-2', 'paidly.com')]
const TOTALS = {
  subtotalKobo: 3_680_000,
  vatKobo: 276_000,
  totalKobo: 3_956_000,
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
  expectedTotalKobo: 3_956_000,
}
const TYPED = 'ns1.host.com\nns2.host.com'

/** A chainable double: a real promise, with the query methods the action calls. */
function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'neq', 'not', 'in', 'update', 'insert']) {
    node[method] = () => node
  }
  node.single = async () => result
  node.maybeSingle = async () => result
  return node
}

let inserted: { orders: unknown[]; items: unknown[] }
/** account_domain_allowance() for an established account (migration 32). */
const ALLOWANCE = {
  ordered: 0,
  max: 20,
  tier: 'standard',
  paid_orders: 1,
  account_days: 12,
  standard_after_days: 7,
  trusted_after_days: 30,
  trusted_after_paid_orders: 3,
}
let allowance: typeof ALLOWANCE

beforeEach(() => {
  vi.clearAllMocks()
  inserted = { orders: [], items: [] }
  allowance = ALLOWANCE

  vi.mocked(requirePaymentEnv).mockReturnValue({
    secretKey: 'FLWSECK_TEST-x-X',
    publicKey: 'FLWPUBK_TEST-x-X',
    webhookHash: 'hash',
    testMode: true,
  })
  vi.mocked(getCartView).mockResolvedValue({
    state: 'ready',
    certificates: [],
    lines: LINES,
    totals: TOTALS,
    vatPct: 7.5,
    lockMinutes: 30,
  } as never)
  vi.mocked(checkAvailability).mockImplementation(async (stems) => ({
    ok: true,
    results: stems.map((name) => ({
      name,
      tld: 'com',
      domain: `${name}.com`,
      status: 'available' as const,
    })),
  }))
  vi.mocked(lookupHost).mockResolvedValue('resolves')
  vi.mocked(callGateway).mockResolvedValue({ balanceUsd: 500 })
  vi.mocked(createPaymentLink).mockResolvedValue('https://checkout.test/pay/1')

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
    // FR-A2: an account well under ten domains — two-factor stays optional.
    from: (table: string) =>
      chain(
        table === 'domains'
          ? { count: 1, error: null }
          : { data: { id: 'contact-1' }, error: null },
      ),
  } as never)
  vi.mocked(createServiceClient).mockReturnValue({
    rpc: async (name: string) =>
      name === 'account_domain_allowance'
        ? { data: allowance, error: null }
        : { data: true, error: null },
    from: (table: string) => {
      if (table === 'tlds') {
        return chain({
          data: [{ name: 'com', register_usd: 11.31, renew_usd: 11.51, is_country_code: false }],
        })
      }
      if (table === 'pricing_settings') return chain({ data: { icann_fee_usd: 0.2 } })
      if (table === 'fx_rates') return chain({ data: { id: 'rate-1' } })
      if (table === 'nameserver_presets') return chain({ data: HOSTINGER, error: null })
      if (table === 'orders') {
        const node = chain({ data: { id: 'order-1', order_number: 'ND-001001' }, error: null })
        node.insert = (row: unknown) => {
          inserted.orders.push(row)
          return node
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
  } as never)
})

/** Nothing moved: no supplier call, no order row, no payment link. */
function expectNothingStarted() {
  expect(checkAvailability).not.toHaveBeenCalled()
  expect(inserted.orders).toEqual([])
  expect(createPaymentLink).not.toHaveBeenCalled()
}

describe('placeOrder — a host that cannot work stops the order before payment (FR-C10, FR-D4)', () => {
  it('stops a typo in typed nameservers, with the details, before anything else moves', async () => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.host.com' ? 'nxdomain' : 'resolves',
    )
    const result = await placeOrder({ ...INPUT, nameservers: TYPED })
    expect(result?.data).toEqual({
      error: 'Some nameservers need fixing before we can use them.',
      field: 'nameservers',
      details: ["ns2.host.com doesn't exist — check the spelling."],
    })
    expectNothingStarted()
  })

  it('stops on one domain’s own typo, naming the domain', async () => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.hots.com' ? 'nxdomain' : 'resolves',
    )
    const result = await placeOrder({
      ...INPUT,
      lineHosts: [
        { domain: 'paidly.com', mode: 'manual', nameservers: 'ns1.host.com ns2.hots.com' },
      ],
    })
    expect(result?.data).toMatchObject({ field: 'lineHosts', domain: 'paidly.com' })
    expectNothingStarted()
  })

  it('refuses a domain’s own choice that is not valid, before any lookup', async () => {
    const result = await placeOrder({
      ...INPUT,
      lineHosts: [{ domain: 'paidly.com', mode: 'manual', nameservers: 'just-one.example.com' }],
    })
    expect(result?.data).toMatchObject({ field: 'lineHosts', domain: 'paidly.com' })
    expect(lookupHost).not.toHaveBeenCalled()
    expectNothingStarted()
  })

  it('refuses two choices for one domain', async () => {
    const result = await placeOrder({
      ...INPUT,
      lineHosts: [
        { domain: 'paidly.com', mode: 'default' },
        { domain: 'paidly.com', mode: 'preset', presetId: HOSTINGER_ID },
      ],
    })
    expect(result?.validationErrors).toBeDefined()
    expectNothingStarted()
  })

  it('looks nothing up for an account over its daily cap (SEC-11)', async () => {
    allowance = { ...ALLOWANCE, ordered: 20 }
    await placeOrder({ ...INPUT, nameservers: TYPED })
    expect(lookupHost).not.toHaveBeenCalled()
  })
})

describe('placeOrder — a host that did not answer warns, and does not block (FR-D4)', () => {
  beforeEach(() => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.host.com' ? 'no-answer' : 'resolves',
    )
  })

  it('shows the warning first, having created and charged nothing', async () => {
    const result = await placeOrder({ ...INPUT, nameservers: TYPED })
    expect(result?.data).toEqual({
      warnings: [
        "ns2.host.com didn't answer just now. It may be busy; double-check it with your host.",
      ],
    })
    expectNothingStarted()
  })

  it('goes ahead with the same choice once the warning has been seen', async () => {
    const result = await placeOrder({ ...INPUT, nameservers: TYPED, hostWarningsSeen: true })
    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders[0]).toMatchObject({ nameservers: ['ns1.host.com', 'ns2.host.com'] })
  })
})

describe('placeOrder — each domain’s host is stored with it (migration 29)', () => {
  it('stores the order’s host on the order, and a domain’s own on its line', async () => {
    const result = await placeOrder({
      ...INPUT,
      nameservers: TYPED,
      lineHosts: [{ domain: 'paidly.com', mode: 'preset', presetId: HOSTINGER_ID }],
    })

    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(inserted.orders[0]).toMatchObject({
      nameservers: ['ns1.host.com', 'ns2.host.com'],
      nameserver_preset_id: null,
    })
    expect(inserted.items[0]).toEqual([
      expect.objectContaining({
        domain: 'getpaid.com',
        nameservers: null,
        nameserver_preset_id: null,
      }),
      expect.objectContaining({
        domain: 'paidly.com',
        nameservers: HOSTINGER.nameservers,
        nameserver_preset_id: HOSTINGER_ID,
      }),
    ])
    // The preset is ours, read from the table; only the typed set is looked up.
    expect(vi.mocked(lookupHost).mock.calls.map(([host]) => host)).toEqual([
      'ns1.host.com',
      'ns2.host.com',
    ])
  })

  it('keeps a domain on the registrar’s default while the rest follow a host', async () => {
    await placeOrder({
      ...INPUT,
      nameservers: TYPED,
      lineHosts: [{ domain: 'getpaid.com', mode: 'default' }],
    })
    expect(inserted.orders[0]).toMatchObject({ nameservers: null, nameserver_preset_id: null })
    expect(inserted.items[0]).toEqual([
      expect.objectContaining({ domain: 'getpaid.com', nameservers: null }),
      expect.objectContaining({
        domain: 'paidly.com',
        nameservers: ['ns1.host.com', 'ns2.host.com'],
        nameserver_preset_id: null,
      }),
    ])
  })
})
