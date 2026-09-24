import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { paymentTestMode } from '@/features/renewals/queries/renewal'
import { env } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import type { RdapLookup } from '../lib/rdap'
import { lookupDomain } from '../queries/rdap-lookup'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/renewals/queries/renewal', () => ({ paymentTestMode: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('../queries/rdap-lookup', () => ({ lookupDomain: vi.fn() }))

const { getTransferCheckoutView } = await import('../queries/transfer-checkout')

const PRICING = {
  tld: 'com',
  isCountryCode: false,
  transfer: { priceKobo: 1_700_000 },
  renewal: { priceKobo: 1_870_000 },
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

function chain(result: unknown) {
  const node = Object.assign(Promise.resolve(result), {} as Record<string, unknown>)
  for (const method of ['select', 'eq', 'neq', 'in', 'limit']) node[method] = () => node
  node.single = async () => result
  node.maybeSingle = async () => result
  return node
}

let user: { id: string; email: string } | null
let own: unknown[]
let heldHere: unknown[]
let tldRow: unknown

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'user-1', email: 'ada@example.com' }
  own = []
  heldHere = []
  tldRow = { is_transferable: true, transfer_usd: 10.61 }
  vi.mocked(getPricedCatalogue).mockResolvedValue({ vatPct: 7.5, tlds: [PRICING] } as never)
  vi.mocked(paymentTestMode).mockReturnValue(true)
  vi.mocked(lookupDomain).mockResolvedValue(found())
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      if (table === 'domains') return chain({ data: own })
      if (table === 'contact_profiles') return chain({ data: null })
      if (table === 'profiles') return chain({ data: { full_name: 'Ada Okafor', phone: null } })
      throw new Error(`unexpected user table ${table}`)
    },
  } as never)
  vi.mocked(createServiceClient).mockReturnValue({
    from: (table: string) => {
      if (table === 'tlds') return chain({ data: tldRow })
      if (table === 'domains') return chain({ data: heldHere })
      throw new Error(`unexpected table ${table}`)
    },
  } as never)
})

describe('getTransferCheckoutView (FR-T1, FR-T2)', () => {
  it('is nobody’s without a session', async () => {
    user = null
    await expect(getTransferCheckoutView('getpaid.com')).resolves.toBeNull()
  })

  it('explains input that is not a domain, before any lookup', async () => {
    await expect(getTransferCheckoutView('getpaid')).resolves.toEqual({
      state: 'invalid',
      message: 'Include the extension — for example getpaid.com, not just getpaid',
    })
    expect(lookupDomain).not.toHaveBeenCalled()
  })

  it('withholds a transfer without prices, or for an extension not cleared (N5b)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null as never)
    await expect(getTransferCheckoutView('getpaid.com')).resolves.toEqual({ state: 'unpriced' })

    vi.mocked(getPricedCatalogue).mockResolvedValue({ vatPct: 7.5, tlds: [PRICING] } as never)
    for (const row of [{ is_transferable: null, transfer_usd: 10.61 }, null]) {
      tldRow = row
      await expect(getTransferCheckoutView('getpaid.com')).resolves.toEqual({
        state: 'not-offered',
        domain: 'getpaid.com',
        tld: 'com',
      })
    }
    tldRow = { is_transferable: true, transfer_usd: 10.61 }
    vi.mocked(getPricedCatalogue).mockResolvedValue({
      vatPct: 7.5,
      tlds: [{ ...PRICING, transfer: null }],
    } as never)
    await expect(getTransferCheckoutView('getpaid.com')).resolves.toMatchObject({
      state: 'not-offered',
    })
    expect(lookupDomain).not.toHaveBeenCalled()
  })

  it('pauses when payments are not set up, or not open to this account', async () => {
    vi.mocked(paymentTestMode).mockReturnValue(null)
    await expect(getTransferCheckoutView('getpaid.com')).resolves.toEqual({
      state: 'payments-off',
    })
    vi.mocked(paymentTestMode).mockReturnValue(true)
    const settings = env as { CHECKOUT_ALLOWLIST?: string }
    const before = settings.CHECKOUT_ALLOWLIST
    settings.CHECKOUT_ALLOWLIST = 'owner@example.com'
    try {
      await expect(getTransferCheckoutView('getpaid.com')).resolves.toEqual({ state: 'closed' })
    } finally {
      settings.CHECKOUT_ALLOWLIST = before
    }
  })

  it('says when the name is already the account’s, already moving, or held here', async () => {
    own = [{ local_status: 'active' }]
    await expect(getTransferCheckoutView('getpaid.com')).resolves.toEqual({
      state: 'yours',
      domain: 'getpaid.com',
    })
    own = [{ local_status: 'transfer_cancelled' }, { local_status: 'transfer_pending' }]
    await expect(getTransferCheckoutView('getpaid.com')).resolves.toEqual({
      state: 'under-way',
      domain: 'getpaid.com',
    })
    own = [{ local_status: 'transfer_rejected' }]
    heldHere = [{ id: 'someone-elses' }]
    await expect(getTransferCheckoutView('getpaid.com')).resolves.toEqual({
      state: 'held',
      domain: 'getpaid.com',
    })
    expect(lookupDomain).not.toHaveBeenCalled()
  })

  it('shows what the registry says is in the way, with the checklist', async () => {
    vi.mocked(lookupDomain).mockResolvedValue(found({ statuses: ['client transfer prohibited'] }))
    const view = await getTransferCheckoutView('getpaid.com')
    expect(view).toMatchObject({
      state: 'blocked',
      domain: 'getpaid.com',
      reason: expect.stringMatching(/has it locked/),
    })
  })

  it('is ready with the price, the checklist and the registrant to pre-fill', async () => {
    const view = await getTransferCheckoutView('https://www.GetPaid.com')
    expect(view).toMatchObject({
      state: 'ready',
      domain: 'getpaid.com',
      tld: 'com',
      pricing: { transfer: { priceKobo: 1_700_000 }, renewal: { priceKobo: 1_870_000 } },
      vatPct: 7.5,
      testMode: true,
      registrant: { firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com' },
    })
    expect(lookupDomain).toHaveBeenCalledWith('getpaid.com')
  })
})
