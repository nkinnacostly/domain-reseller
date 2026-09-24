import {
  type AvailabilityStatus,
  type PricingInputs,
  priceCatalogue,
  type TldRecord,
} from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { type PublicPriceRow, toPublicRow } from '@/features/pricing/lib/public-row'
import { server } from '../../../../tests/mocks/server'
import {
  ExactSection,
  ExactSkeleton,
  GridSection,
  GridSkeleton,
  Suggestions,
  SuggestionsSkeleton,
} from '../components/availability-sections'
import { planSearch } from '../lib/plan'

// env.ts reads process.env once, at import: point it at a test gateway first.
vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const GATEWAY = 'http://gateway.test/v1/availability'

// Fixed inputs so expectations do not move with the live rate.
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const record = (name: string, registerUsd: number, renewUsd: number): TldRecord => ({
  name,
  registerUsd,
  renewUsd,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: name.length === 2,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})

const catalogue = priceCatalogue(
  [
    record('com', 11.31, 11.51),
    record('africa', 14, 16),
    record('net', 12, 14),
    record('org', 10, 12),
  ],
  INPUTS,
)
const prices = new Map(catalogue.map((pricing) => [pricing.tld, toPublicRow(pricing)]))
const price = (tld: string) => prices.get(tld) as PublicPriceRow
const sold = new Set(prices.keys())
const FEATURED = ['com', 'africa', 'net']

const plan = (stem: string, tld: string | null, featured = FEATURED) =>
  planSearch({ stem, tld, sold, featured })

type Body = { names: string[]; tlds: string[]; priority: string }

/** Answers every name × extension with one status, recording what was asked. */
function gateway(status: (name: string, tld: string) => AvailabilityStatus = () => 'available') {
  const asked: Body[] = []
  server.use(
    http.post(GATEWAY, async ({ request }) => {
      const body = (await request.json()) as Body
      asked.push(body)
      return HttpResponse.json({
        ok: true,
        data: {
          results: body.names.flatMap((name) =>
            body.tlds.map((tld) => ({
              name,
              tld,
              domain: `${name}.${tld}`,
              status: status(name, tld),
            })),
          ),
        },
      })
    }),
  )
  return asked
}

const refuse = (code: string, status: number) =>
  HttpResponse.json({ ok: false, code, message: 'no', retryable: true }, { status })

describe('ExactSection', () => {
  it('leads with the exact match and both of its prices, asked for at high priority (N8)', async () => {
    const asked = gateway()
    render(await ExactSection({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(screen.getByRole('heading', { level: 2, name: 'getpaid.com' })).toBeInTheDocument()
    expect(screen.getByText(price('com').register)).toBeInTheDocument()
    expect(screen.getByText(`${price('com').renew}/yr`)).toBeInTheDocument()
    expect(asked).toEqual([{ names: ['getpaid'], tlds: ['com'], priority: 'high' }])
  })

  it('says the registry is busy, and offers the same search again, when rate-limited', async () => {
    server.use(http.post(GATEWAY, () => refuse('RATE_LIMITED', 429)))
    render(await ExactSection({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('A lot of people are searching right now')
    expect(within(status).getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/search?q=getpaid.com',
    )
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })

  it('asks nothing when the typed extension is one we do not sell', async () => {
    const asked = gateway()
    const ui = await ExactSection({ plan: plan('getpaid', 'xyz'), prices, query: 'getpaid.xyz' })

    expect(ui).toBeNull()
    expect(asked).toEqual([])
  })

  it('shows nothing rather than a guess when the gateway returns no result for the name', async () => {
    server.use(http.post(GATEWAY, () => HttpResponse.json({ ok: true, data: { results: [] } })))
    const ui = await ExactSection({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' })

    expect(ui).toBeNull()
  })
})

describe('GridSection', () => {
  it('checks the name on the other featured extensions, not the exact one again', async () => {
    const asked = gateway((_, tld) => (tld === 'net' ? 'registered' : 'available'))
    render(await GridSection({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(
      screen.getByRole('heading', { level: 2, name: 'getpaid on other extensions' }),
    ).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'getpaid on other extensions' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.dataset.status),
    ).toEqual(['available', 'registered'])
    expect(list).toHaveTextContent(`then ${price('africa').renew}/yr`)
    expect(asked).toEqual([{ names: ['getpaid'], tlds: ['africa', 'net'], priority: 'normal' }])
  })

  it('keeps its heading and explains the outage when the registry cannot be reached', async () => {
    server.use(http.post(GATEWAY, () => refuse('SUPPLIER_UNAVAILABLE', 502)))
    render(await GridSection({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(screen.getByRole('heading', { name: 'getpaid on other extensions' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent("We couldn't reach the registry just now")
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('renders nothing when the exact match is the only featured extension', async () => {
    const asked = gateway()
    const ui = await GridSection({
      plan: plan('getpaid', 'com', ['com']),
      prices,
      query: 'getpaid.com',
    })

    expect(ui).toBeNull()
    expect(asked).toEqual([])
  })
})

describe('Suggestions', () => {
  const lists = () =>
    screen.getAllByRole('list').map((list) => ({
      label: list.getAttribute('aria-label'),
      domains: within(list)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('span')?.textContent),
    }))

  it('asks only the lead extension when it leaves enough free names (PRD V4)', async () => {
    // "shop" takes all twelve affixes, so one call can fill the list.
    const asked = gateway()
    render(await Suggestions({ plan: plan('shop', 'com'), prices, query: 'shop.com' }))

    expect(asked.map((body) => body.tlds)).toEqual([['com']])
    expect(
      screen.getByRole('heading', { level: 2, name: 'Available alternatives' }),
    ).toBeInTheDocument()
    const [first, second] = lists()
    expect(first?.label).toBe('Available alternatives')
    expect(first?.domains).toHaveLength(6)
    expect(second?.label).toBe('More available alternatives')
    expect(second?.domains).toHaveLength(6)
    expect(first?.domains?.[0]).toBe('getshop.com')
  })

  it('tops up from the second extension when the first leaves fewer than twelve', async () => {
    // "getpaid" never becomes "getgetpaid", so .com alone gives eleven.
    const asked = gateway()
    render(await Suggestions({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(asked.map((body) => body.tlds)).toEqual([['com'], ['africa']])
    const shown = lists().flatMap((list) => list.domains)
    expect(shown).toHaveLength(12)
    // The lead extension first, then the top-up.
    expect(shown.filter((domain) => domain?.endsWith('.com'))).toHaveLength(11)
    expect(shown.at(-1)).toBe('trygetpaid.africa')
    // Every suggestion carries its own extension's renewal price (N8).
    const renewals = screen
      .getAllByRole('listitem')
      .map((li) => (li.textContent?.includes('.africa') ? price('africa') : price('com')))
    screen.getAllByRole('listitem').forEach((li, index) => {
      expect(li).toHaveTextContent(`then ${renewals[index]?.renew}/yr`)
    })
  })

  it('keeps what the first extension found when the top-up call fails', async () => {
    const asked: string[][] = []
    server.use(
      http.post(GATEWAY, async ({ request }) => {
        const body = (await request.json()) as Body
        asked.push(body.tlds)
        if (body.tlds.includes('africa')) return refuse('SUPPLIER_UNAVAILABLE', 502)
        return HttpResponse.json({
          ok: true,
          data: {
            results: body.names.map((name) => ({
              name,
              tld: 'com',
              domain: `${name}.com`,
              status: 'available',
            })),
          },
        })
      }),
    )
    render(await Suggestions({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(asked).toEqual([['com'], ['africa']])
    expect(lists().flatMap((list) => list.domains)).toHaveLength(11)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('explains the failure under its heading when the lead extension cannot be checked', async () => {
    server.use(http.post(GATEWAY, () => refuse('RATE_LIMITED', 429)))
    render(await Suggestions({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(screen.getByRole('heading', { name: 'Available alternatives' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('A lot of people are searching')
  })

  it('says so when none of the variations is free', async () => {
    gateway(() => 'registered')
    render(await Suggestions({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(screen.getByText(/None of our usual variations are free/)).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('shows a single list when only one alternative is free', async () => {
    gateway((name, tld) => (name === 'mygetpaid' && tld === 'com' ? 'available' : 'registered'))
    render(await Suggestions({ plan: plan('getpaid', 'com'), prices, query: 'getpaid.com' }))

    expect(lists()).toEqual([{ label: 'Available alternatives', domains: ['mygetpaid.com'] }])
  })

  it('asks nothing when there is no extension to suggest on', async () => {
    const asked = gateway()
    const ui = await Suggestions({
      plan: planSearch({ stem: 'getpaid', tld: null, sold, featured: [] }),
      prices,
      query: 'getpaid',
    })

    expect(ui).toBeNull()
    expect(asked).toEqual([])
  })
})

describe('loading placeholders', () => {
  it.each([
    ['exact match', ExactSkeleton],
    ['extension grid', GridSkeleton],
    ['suggestions', SuggestionsSkeleton],
  ])('the %s skeleton is hidden from assistive tech', (_, Skeleton) => {
    const { container } = render(<Skeleton />)

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})
