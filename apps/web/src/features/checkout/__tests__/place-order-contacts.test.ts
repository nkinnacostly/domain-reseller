import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCartView } from '@/features/cart/queries/cart'
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

/**
 * FR-A4, FR-C5 — the administrative, technical and billing contacts at
 * checkout. Each is checked on the server before anything is priced,
 * checked or charged; a saved profile is read again under RLS.
 */

const PROFILE_ID = '7d7f7a0e-1c61-4c4f-9f7e-0a6a2f9b1a11'
const REGISTRANT = {
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
}
const BILLING = {
  ...REGISTRANT,
  firstName: 'Bola',
  lastName: 'Ade',
  email: 'accounts@example.com',
  phone: '0803 987 6543',
}
const PROFILE_ROW = {
  id: PROFILE_ID,
  label: 'Tech',
  is_default: false,
  first_name: 'Chi',
  last_name: 'Obi',
  company: null,
  email: 'tech@example.com',
  phone: '8035550000',
  phone_country_code: '234',
  address_line1: '3 Awolowo Road',
  address_line2: null,
  city: 'Lagos',
  state: 'Lagos',
  zip_code: '100001',
  country: 'NG',
}
const TOTAL = 1_978_000
const order = (contacts?: unknown) =>
  placeOrder({
    registrant: REGISTRANT,
    confirmed: true,
    expectedTotalKobo: TOTAL,
    ...(contacts ? { contacts } : {}),
  } as never)

function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'neq', 'not', 'in', 'update', 'insert']) {
    node[method] = () => node
  }
  node.single = async () => result
  node.maybeSingle = async () => result
  return node
}

let insertedOrders: Record<string, unknown>[]
/** Every contact_profiles lookup made as the user, as [column, value]. */
let profileLookups: unknown[][]

function userClient(profile: unknown = PROFILE_ROW) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } }) },
    from: (table: string) => {
      // FR-A2: an account well under ten domains — two-factor stays optional.
      if (table === 'domains') return chain({ count: 1, error: null })
      if (table !== 'contact_profiles') throw new Error(`unexpected user table ${table}`)
      // A chosen profile read back by its id; otherwise the default checkout keeps.
      const node = chain({ data: { id: 'contact-1' }, error: null })
      let byId = false
      node.eq = (...args: unknown[]) => {
        profileLookups.push(args)
        if (args[0] === 'id') byId = true
        return node
      }
      node.maybeSingle = async () =>
        byId ? { data: profile, error: null } : { data: { id: 'contact-1' }, error: null }
      return node
    },
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  insertedOrders = []
  profileLookups = []
  vi.mocked(requirePaymentEnv).mockReturnValue({
    secretKey: 'FLWSECK_TEST-x-X',
    publicKey: 'FLWPUBK_TEST-x-X',
    webhookHash: 'hash',
    testMode: true,
  })
  vi.mocked(getCartView).mockResolvedValue({
    state: 'ready',
    certificates: [],
    lines: [
      {
        id: 'line-1',
        domain: 'getpaid.com',
        tld: 'com',
        periodYears: 1,
        privacy: true,
        autoRenew: true,
        privacyOffered: true,
        payableKobo: 1_840_000,
        renewalKobo: 1_870_000,
        status: 'current',
        minPeriod: 1,
        registerPeriods: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        unsoldYears: null,
        renewYears: 1,
      },
    ],
    totals: {
      subtotalKobo: 1_840_000,
      vatKobo: 138_000,
      totalKobo: TOTAL,
      needsAcknowledgement: false,
      unavailableCount: 0,
    },
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
  vi.mocked(createServiceClient).mockReturnValue({
    rpc: async (name: string) =>
      name === 'account_domain_allowance'
        ? {
            data: {
              ordered: 0,
              max: 20,
              tier: 'standard',
              paid_orders: 1,
              account_days: 12,
              standard_after_days: 7,
              trusted_after_days: 30,
              trusted_after_paid_orders: 3,
            },
            error: null,
          }
        : { data: true, error: null },
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
        node.insert = (row: Record<string, unknown>) => {
          insertedOrders.push(row)
          return insert()
        }
        return node
      }
      if (table === 'order_items') return { insert: async () => ({ error: null }) }
      throw new Error(`unexpected table ${table}`)
    },
  } as never)
})

describe('placeOrder — other contacts that cannot be used stop the order first', () => {
  it('refuses a saved contact that is not the account’s own, before anything is checked or charged', async () => {
    userClient(null)
    const result = await order({ billing: { kind: 'profile', profileId: PROFILE_ID } })
    expect(result?.data).toEqual({
      error:
        'Billing contact: That saved contact is no longer on your account. Choose another, or enter new details.',
      field: 'contacts.billing',
    })
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(insertedOrders).toEqual([])
    expect(createPaymentLink).not.toHaveBeenCalled()
  })

  it('marks new details that fail the registrant’s checks beside the field', async () => {
    const result = await order({ technical: { kind: 'new', contact: { ...BILLING, email: 'x' } } })
    expect(result?.validationErrors).toMatchObject({
      contacts: { technical: { contact: { email: { _errors: ['Enter a valid email address'] } } } },
    })
    expect(insertedOrders).toEqual([])
  })

  it('refuses a phone number the registry would not take', async () => {
    const result = await order({
      billing: { kind: 'new', contact: { ...BILLING, phone: '0803 123 4567 8901 2345' } },
    })
    expect(result?.data).toEqual({
      error: 'Billing contact: Check the phone number: it should be 4 to 15 digits after the code.',
      field: 'contacts.billing',
    })
    expect(insertedOrders).toEqual([])
  })
})

describe('placeOrder — the order carries the other contacts (migration 29)', () => {
  it('stores no other contacts when the registrant holds every role', async () => {
    expect((await order())?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(insertedOrders[0]).toMatchObject({ contacts: null })
    expect(profileLookups).not.toContainEqual(['id', PROFILE_ID])
  })

  it('stores each role someone else holds, normalised, and leaves the registrant’s out', async () => {
    const result = await order({
      administrative: { kind: 'registrant' },
      technical: { kind: 'profile', profileId: PROFILE_ID },
      billing: { kind: 'new', contact: BILLING },
    })
    expect(result?.data).toEqual({ redirectTo: 'https://checkout.test/pay/1' })
    expect(profileLookups).toContainEqual(['id', PROFILE_ID])
    expect(insertedOrders[0]?.contacts).toEqual({
      technical: expect.objectContaining({ firstName: 'Chi', email: 'tech@example.com' }),
      billing: expect.objectContaining({
        firstName: 'Bola',
        phone: '8039876543',
        phoneCountryCode: '234',
      }),
    })
  })

  it('treats the registrant’s own details in a role as the registrant’s', async () => {
    await order({ billing: { kind: 'new', contact: { ...REGISTRANT, email: 'ADA@example.com' } } })
    expect(insertedOrders[0]).toMatchObject({ contacts: null })
  })
})
