import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { env, requirePaymentEnv } from '@/lib/env'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/env', async (original) => ({
  ...(await original<typeof import('@/lib/env')>()),
  requirePaymentEnv: vi.fn(),
}))

const { getBulkRenewalView } = await import('../queries/renewal')

const NOW = new Date('2026-09-24T12:00:00.000Z')
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

const domain = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  domain_name: name,
  tld: name.split('.').slice(1).join('.'),
  source: 'registration',
  test_mode: true,
  local_status: 'active',
  expires_at: '2027-09-24T12:00:00.000Z',
  order_items: { renewal_kobo: 1_000_000 },
  ...overrides,
})

/** The user's own client (RLS): their domains, their renewal lines, and who they are. */
function userClient({
  domains = [] as unknown[] | null,
  domainsError = null as unknown,
  lines = [] as unknown[],
} = {}) {
  const table = (data: unknown, error: unknown = null) => {
    const query = Promise.resolve({ data, error }) as Promise<unknown> & Record<string, unknown>
    for (const method of ['select', 'eq', 'in', 'order']) query[method] = () => query
    return query
  }
  vi.mocked(createClient).mockResolvedValue({
    from: (name: string) => (name === 'domains' ? table(domains, domainsError) : table(lines)),
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } }) },
  } as never)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(requirePaymentEnv).mockReturnValue({ testMode: true } as never)
  vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
})
afterEach(() => vi.useRealTimers())

describe('getBulkRenewalView (FR-P4, FR-P5)', () => {
  it('judges each domain by the one-domain rules, in the order asked for', async () => {
    userClient({
      domains: [
        domain('b', 'second.com'),
        domain('a', 'first.com'),
        domain('c', 'sample.com', { source: 'demo' }),
        domain('d', 'naija.ng'),
      ],
      lines: [
        {
          domain_id: 'b',
          status: 'provisioning',
          renewal_kobo: 1_870_000,
          created_at: 'x',
          orders: { status: 'paid' },
        },
      ],
    })
    const view = await getBulkRenewalView(['a', 'b', 'c', 'd', 'not-mine'])

    expect(view.lines.map((line) => [line.domainName, line.check])).toEqual([
      ['first.com', { ok: true, maxYears: 9, years: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
      [
        'second.com',
        { ok: false, reason: 'A renewal of this domain is already paid for and being made.' },
      ],
      ['sample.com', { ok: false, reason: 'Demo domains can’t be renewed.' }],
      [
        'naija.ng',
        { ok: false, reason: 'Renewal prices for this extension are unavailable right now.' },
      ],
    ])
    expect(view.lines[0]?.pricing?.tld).toBe('com')
    expect(view.lines[3]?.pricing).toBeNull()
    expect(view).toMatchObject({ vatPct: 7.5, paymentTestMode: true, open: true })
  })

  it('knows the renewal price last paid, or promised at purchase (FR-RN7)', async () => {
    userClient({
      domains: [domain('a', 'first.com'), domain('b', 'second.com', { order_items: null })],
      lines: [
        {
          domain_id: 'a',
          status: 'completed',
          renewal_kobo: '1500000',
          created_at: 'x',
          orders: { status: 'completed' },
        },
      ],
    })
    const view = await getBulkRenewalView(['a', 'b'])
    expect(view.lines.map((line) => line.previousRenewalKobo)).toEqual([1_500_000, null])
  })

  it('withholds prices, and says payments are closed, when they are', async () => {
    const settings = env as { CHECKOUT_ALLOWLIST?: string }
    const before = settings.CHECKOUT_ALLOWLIST
    settings.CHECKOUT_ALLOWLIST = 'owner@example.com'
    vi.mocked(getPricedCatalogue).mockResolvedValue(null as never)
    try {
      userClient({ domains: [domain('a', 'first.com')] })
      const view = await getBulkRenewalView(['a'])
      expect(view.open).toBe(false)
      expect(view.vatPct).toBe(0)
      expect(view.lines[0]?.check).toEqual({
        ok: false,
        reason: 'Renewal prices for this extension are unavailable right now.',
      })
    } finally {
      settings.CHECKOUT_ALLOWLIST = before
    }
  })

  it('throws when the domains cannot be read, so the page shows its error state', async () => {
    userClient({ domains: null, domainsError: { code: '08006' } })
    await expect(getBulkRenewalView(['a'])).rejects.toThrow()
  })
})
