import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'
import { uninstallTurnstile } from '../../../../tests/mocks/turnstile'

const state = vi.hoisted(() => ({ withinLimit: true }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '102.89.1.2' }),
  cookies: async () => ({ get: () => undefined }),
}))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: async () => ({ data: state.withinLimit, error: null }) }),
}))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../queries/length-rules', () => ({ getLengthRules: async () => ({}) }))

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record: TldRecord = {
  name: 'com',
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
}

/** env.ts reads process.env once, at import — so the page is loaded fresh with the keys set. */
async function results(q: string) {
  vi.resetModules()
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key')
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret-key')
  const { getPricedCatalogue } = await import('@/features/pricing/queries/pricing')
  const tlds = priceCatalogue([record], INPUTS)
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds,
    featured: tlds.map((tld) => ({ ...tld, tagline: null })),
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date(),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  })
  const { SearchResults } = await import('../components/search-results')
  render(await SearchResults({ searchParams: Promise.resolve({ q }) }))
}

function recordGateway() {
  const asked: unknown[] = []
  server.use(
    http.post('*/v1/availability', async ({ request }) => {
      asked.push(await request.json())
      return HttpResponse.json({ ok: true, data: { results: [] } })
    }),
  )
  return asked
}

beforeEach(() => {
  uninstallTurnstile()
  state.withinLimit = true
})
afterEach(() => vi.unstubAllEnvs())

describe('SearchResults past the free allowance, with Turnstile on (SEC-9)', () => {
  it('shows the check in place of results, and asks the supplier nothing', async () => {
    const asked = recordGateway()
    state.withinLimit = false

    await results('getpaid.com')

    const check = screen.getByRole('region', { name: 'Confirm you’re a person to keep searching' })
    expect(check).toHaveTextContent('This connection has searched a lot in the last few minutes.')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(asked).toEqual([])
  })

  it('within the allowance, searches as before', async () => {
    await results('getpaid.com')

    expect(
      screen.queryByRole('region', { name: 'Confirm you’re a person to keep searching' }),
    ).not.toBeInTheDocument()
  })
})
