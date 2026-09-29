import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DomainDetail, getDomain } from '@/features/domains/queries/domains'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/features/domains/queries/domains', () => ({ getDomain: vi.fn() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))

const { getRenewalView, paymentTestMode } = await import('../queries/renewal')

const NOW = new Date('2026-09-24T12:00:00.000Z')
const ALREADY_PAID = 'A renewal of this domain is already paid for and being made.'
const NO_PRICES = 'Renewal prices for this extension are unavailable right now.'

const DOMAIN: DomainDetail = {
  id: 'domain-1',
  domainName: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  testMode: true,
  status: 'active',
  expiresAt: '2027-09-24T12:00:00.000Z',
  autoRenew: true,
  privacyEnabled: true,
  delegationStatus: 'verified',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  pendingNameservers: null,
  registeredAt: '2025-09-24T12:00:00.000Z',
  transferLock: true,
  presetId: null,
  previousNameservers: null,
  registrant: null,
  failureCode: null,
  promisedRenewalKobo: 1_870_000,
  labels: [],
}

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const COM: TldRecord = {
  name: 'com',
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: 10.61,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
}
const CATALOGUE: PricedCatalogue = {
  tlds: priceCatalogue([COM], INPUTS),
  featured: [],
  effectiveRate: 1333.76,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

/** One renewal line as the query reads it, with its order's status. */
const line = (status: string, orderStatus: string, renewalKobo: number | string = 1_870_000) => ({
  status,
  renewal_kobo: renewalKobo,
  created_at: '2026-09-01T09:00:00.000Z',
  orders: { status: orderStatus },
})

type Step = [string, ...unknown[]]

/** The user's own client (RLS): their renewal lines, newest first, and who they are. */
function userClient({
  lines = [] as unknown[] | null,
  email = 'ada@example.com' as string | null,
} = {}) {
  const steps: Step[] = []
  const query = Promise.resolve({ data: lines, error: null }) as Promise<unknown> &
    Record<string, unknown>
  for (const method of ['select', 'eq', 'order']) {
    query[method] = (...args: unknown[]) => {
      steps.push([method, ...args])
      return query
    }
  }
  const from = vi.fn(() => query)
  const auth = {
    getUser: async () => ({ data: { user: email === null ? null : { id: 'user-1', email } } }),
  }
  vi.mocked(createClient).mockResolvedValue({ from, auth } as never)
  return { steps, from }
}

function paymentsIn(testMode: boolean) {
  vi.mocked(requirePaymentEnv).mockReturnValue({
    secretKey: 'FLWSECK_TEST-x-X',
    publicKey: 'FLWPUBK_TEST-x-X',
    webhookHash: 'hash',
    testMode,
  } as never)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  paymentsIn(true)
  vi.mocked(getDomain).mockResolvedValue(DOMAIN)
  vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
  userClient()
})

afterEach(() => vi.useRealTimers())

describe('paymentTestMode', () => {
  it('reports which side the payment keys are on', () => {
    paymentsIn(true)
    expect(paymentTestMode()).toBe(true)
    paymentsIn(false)
    expect(paymentTestMode()).toBe(false)
  })

  it('is null when payments are not set up, rather than throwing', () => {
    vi.mocked(requirePaymentEnv).mockImplementation(() => {
      throw new Error('Payments are not configured')
    })
    expect(paymentTestMode()).toBeNull()
  })
})

describe('getRenewalView', () => {
  it('is null for a domain that is not the user’s, and reads nothing else', async () => {
    vi.mocked(getDomain).mockResolvedValue(null)
    expect(await getRenewalView('someone-else.com')).toBeNull()
    expect(createClient).not.toHaveBeenCalled()
    expect(getPricedCatalogue).not.toHaveBeenCalled()
  })

  it('offers a renewable domain up to ten years ahead, priced from the catalogue', async () => {
    const view = await getRenewalView('getpaid.com')
    expect(getDomain).toHaveBeenCalledWith('getpaid.com')
    expect(view).toEqual({
      domain: DOMAIN,
      pricing: CATALOGUE.tlds[0],
      vatPct: 7.5,
      previousRenewalKobo: 1_870_000,
      paymentTestMode: true,
      open: true,
      // Expiring a year from now, so nine more years reach the ten-year limit.
      check: { ok: true, maxYears: 9, years: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    })
  })

  it('reads only this domain’s renewal lines, newest first', async () => {
    const { steps, from } = userClient()
    await getRenewalView('getpaid.com')
    expect(from).toHaveBeenCalledWith('order_items')
    expect(steps).toContainEqual(['eq', 'domain_id', 'domain-1'])
    expect(steps).toContainEqual(['eq', 'item_type', 'renew'])
    expect(steps).toContainEqual(['order', 'created_at', { ascending: false }])
  })

  describe('a renewal already under way (FR-RN5)', () => {
    it.each([
      ['pending', 'paid'],
      ['pending', 'provisioning'],
      ['provisioning', 'paid'],
      ['provisioning', 'provisioning'],
    ])(
      'refuses a second one while a %s line in a %s order is being made',
      async (status, order) => {
        userClient({ lines: [line(status, order)] })
        const view = await getRenewalView('getpaid.com')
        expect(view?.check).toEqual({ ok: false, reason: ALREADY_PAID })
      },
    )

    it.each([
      ['pending', 'awaiting_payment'],
      ['pending', 'cancelled'],
      ['completed', 'completed'],
      ['failed', 'failed'],
    ])('does not count a %s line in a %s order as under way', async (status, order) => {
      userClient({ lines: [line(status, order)] })
      const view = await getRenewalView('getpaid.com')
      expect(view?.check).toEqual({ ok: true, maxYears: 9, years: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
    })
  })

  describe('the renewal price to compare with (FR-RN7)', () => {
    it('is the one on the latest completed renewal, read as a number', async () => {
      userClient({
        lines: [
          line('pending', 'awaiting_payment', 2_200_000),
          line('completed', 'completed', '2050000'),
          line('completed', 'completed', 1_900_000),
        ],
      })
      const view = await getRenewalView('getpaid.com')
      expect(view?.previousRenewalKobo).toBe(2_050_000)
    })

    it('is the one quoted when the domain was bought, until a renewal completes', async () => {
      userClient({ lines: [line('failed', 'failed', 2_200_000)] })
      const view = await getRenewalView('getpaid.com')
      expect(view?.previousRenewalKobo).toBe(1_870_000)
    })

    it('is the quoted one when the lines cannot be read', async () => {
      userClient({ lines: null })
      const view = await getRenewalView('getpaid.com')
      expect(view?.previousRenewalKobo).toBe(1_870_000)
      expect(view?.check).toEqual({ ok: true, maxYears: 9, years: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
    })

    it('is unknown when nothing was ever quoted or paid', async () => {
      vi.mocked(getDomain).mockResolvedValue({ ...DOMAIN, promisedRenewalKobo: null })
      const view = await getRenewalView('getpaid.com')
      expect(view?.previousRenewalKobo).toBeNull()
    })
  })

  describe('the pre-launch allowlist', () => {
    // env is read-only by type; the gate reads it at call time.
    const settings = env as { CHECKOUT_ALLOWLIST?: string }
    let before: string | undefined

    beforeEach(() => {
      before = settings.CHECKOUT_ALLOWLIST
      settings.CHECKOUT_ALLOWLIST = 'owner@example.com'
    })

    afterEach(() => {
      settings.CHECKOUT_ALLOWLIST = before
    })

    it('is closed to an account not on the list', async () => {
      const view = await getRenewalView('getpaid.com')
      expect(view?.open).toBe(false)
    })

    it('is open to an account on the list', async () => {
      userClient({ email: 'Owner@Example.com' })
      const view = await getRenewalView('getpaid.com')
      expect(view?.open).toBe(true)
    })
  })

  describe('when the price cannot be known', () => {
    it('refuses a domain whose extension is not in the catalogue', async () => {
      vi.mocked(getDomain).mockResolvedValue({ ...DOMAIN, domainName: 'getpaid.xyz', tld: 'xyz' })
      const view = await getRenewalView('getpaid.xyz')
      expect(view?.pricing).toBeNull()
      expect(view?.check).toEqual({ ok: false, reason: NO_PRICES })
    })

    it('refuses while prices are withheld, and charges no VAT on nothing', async () => {
      vi.mocked(getPricedCatalogue).mockResolvedValue(null)
      const view = await getRenewalView('getpaid.com')
      expect(view?.pricing).toBeNull()
      expect(view?.vatPct).toBe(0)
      expect(view?.check).toEqual({ ok: false, reason: NO_PRICES })
    })
  })

  it('pauses renewals when payments are not set up', async () => {
    vi.mocked(requirePaymentEnv).mockImplementation(() => {
      throw new Error('Payments are not configured')
    })
    const view = await getRenewalView('getpaid.com')
    expect(view?.paymentTestMode).toBeNull()
    expect(view?.check).toEqual({
      ok: false,
      reason: 'Payments aren’t set up here, so renewals are paused.',
    })
  })

  it('will not renew a test domain with a live payment', async () => {
    paymentsIn(false)
    const view = await getRenewalView('getpaid.com')
    expect(view?.check).toEqual({
      ok: false,
      reason:
        'This domain is in the registrar’s test system, so it can’t be renewed with a real payment.',
    })
  })
})
