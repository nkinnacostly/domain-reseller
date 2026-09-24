import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { HttpResponse, http, type JsonBodyType } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PricedCatalogue } from '@/features/pricing/queries/pricing'
import { server } from '../../../../tests/mocks/server'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))

const { createServiceClient } = await import('@/lib/supabase/service')
const { getPricedCatalogue } = await import('@/features/pricing/queries/pricing')
const { WhoisResult } = await import('../components/whois-result')

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const tld = (name: string, isCountryCode = false): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: 10.61,
  restoreUsd: null,
  isCountryCode,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const CATALOGUE: PricedCatalogue = {
  tlds: priceCatalogue([tld('com'), tld('co', true)], INPUTS),
  featured: [],
  effectiveRate: 1334,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

/** The rate limiter's database call: `allowed` for every key unless told otherwise. */
function limiter(answer: (key: string) => boolean | Error = () => true) {
  const rpc = vi.fn(async (_fn: string, args: { p_key: string }) => {
    const verdict = answer(args.p_key)
    if (verdict instanceof Error) throw verdict
    return { data: verdict, error: null }
  })
  vi.mocked(createServiceClient).mockReturnValue({ rpc } as never)
  return rpc
}

function registry(body: JsonBodyType, status = 200) {
  server.use(
    http.get('https://rdap.test/verisign/domain/:name', () => HttpResponse.json(body, { status })),
  )
}

const LOCKED = {
  objectClassName: 'domain',
  status: ['client transfer prohibited', 'vendor special hold'],
  events: [
    { eventAction: 'registration', eventDate: '2010-04-12T09:30:00Z' },
    { eventAction: 'expiration', eventDate: '2031-04-12T09:30:00Z' },
    { eventAction: 'transfer', eventDate: '2018-06-01T00:00:00Z' },
  ],
  entities: [
    {
      roles: ['registrar'],
      vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar, Inc.']]],
    },
    {
      roles: ['registrant'],
      vcardArray: [
        'vcard',
        [
          ['fn', {}, 'text', 'Adaeze Placeholder'],
          ['email', {}, 'text', 'adaeze.placeholder@example.net'],
        ],
      ],
    },
  ],
  nameservers: [{ ldhName: 'NS1.EXAMPLE-DNS.NET' }, { ldhName: 'NS2.EXAMPLE-DNS.NET' }],
}

async function renderFor(domain?: string | string[]) {
  const ui = await WhoisResult({
    searchParams: Promise.resolve(domain === undefined ? {} : { domain }),
  })
  return render(ui)
}

const heading = () => screen.getByRole('heading', { level: 2 })

describe('WhoisResult', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T13:05:00Z'))
    vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
    limiter()
  })
  afterEach(() => vi.useRealTimers())

  it('renders nothing until a domain is asked about, and counts nothing', async () => {
    const rpc = limiter()
    const { container } = await renderFor('  ')
    expect(container).toBeEmptyDOMElement()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('explains input that is not a domain, without a lookup', async () => {
    const rpc = limiter()
    await renderFor('getpaid')
    expect(heading()).toHaveTextContent("That doesn't look like a domain")
    expect(screen.getByText(/Include the extension/)).toBeInTheDocument()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('counts each lookup per person by a keyed hash of the address, never the address', async () => {
    registry(LOCKED)
    const rpc = limiter()
    await renderFor(['lockedbrand.com', 'ignored.com'])

    const keys = rpc.mock.calls.map(([, args]) => args.p_key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/^whois:[0-9a-f]{32}$/)
    expect(keys[1]).toBe('whois:all')
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('203.0.113.7')
  })

  it('refuses once a person has looked up too many, without asking the registry', async () => {
    const lookup = vi.fn(() => HttpResponse.json(LOCKED))
    server.use(http.get('https://rdap.test/verisign/domain/:name', lookup))
    limiter((key) => key === 'whois:all')

    await renderFor('lockedbrand.com')

    expect(heading()).toHaveTextContent('Too many lookups just now')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses when everyone together has looked up too many', async () => {
    limiter((key) => key !== 'whois:all')
    await renderFor('lockedbrand.com')
    expect(heading()).toHaveTextContent('Too many lookups just now')
  })

  it('fails closed when the limit cannot be checked', async () => {
    limiter(() => new Error('database down'))
    await renderFor('lockedbrand.com')
    expect(heading()).toHaveTextContent('Too many lookups just now')
  })

  it('shows a registered domain’s registrar, dates, statuses and nameservers', async () => {
    registry(LOCKED)
    await renderFor('https://www.LockedBrand.com/')

    expect(heading()).toHaveTextContent('lockedbrand.com is registered')
    expect(
      screen.getByText('It is registered through Example Registrar, Inc. until 12 April 2031.'),
    ).toBeInTheDocument()
    expect(screen.getByText('12 April 2010')).toBeInTheDocument()
    expect(screen.getByText('1 June 2018')).toBeInTheDocument()

    const statuses = screen.getByRole('list', { name: 'Status codes' })
    expect(within(statuses).getByText('client transfer prohibited')).toBeInTheDocument()
    expect(within(statuses).getByText(/locked it against transfers/)).toBeInTheDocument()
    // An unknown status is shown as written, without a made-up gloss.
    expect(within(statuses).getByText('vendor special hold')).toBeInTheDocument()

    expect(
      within(screen.getByRole('list', { name: 'Nameservers' })).getAllByRole('listitem'),
    ).toHaveLength(2)
    expect(screen.getByText(/To reach the owner, contact Example Registrar, Inc\./)).toBeVisible()
    expect(
      screen.getByText(/public record at 14:05 on 24 September 2026, Lagos time/),
    ).toBeInTheDocument()
  })

  it('never shows the registrant, even when the registry publishes them', async () => {
    registry(LOCKED)
    const { container } = await renderFor('lockedbrand.com')
    expect(container.textContent).not.toMatch(/Adaeze|example\.net/)
  })

  it('says what the registry left out', async () => {
    registry({ objectClassName: 'domain' })
    await renderFor('lockedbrand.com')

    expect(screen.getByText('Not published by the registry')).toBeInTheDocument()
    expect(screen.getByText(/None listed/)).toBeInTheDocument()
    expect(screen.getByText('None published')).toBeInTheDocument()
    expect(screen.getByText(/contact the registrar\./)).toBeInTheDocument()
  })

  it('offers to register a name the registry has no record of', async () => {
    registry({ errorCode: 404 }, 404)
    await renderFor('free-name.com')

    expect(heading()).toHaveTextContent("free-name.com isn't registered")
    expect(screen.getByRole('link', { name: /Register free-name\.com/ })).toHaveAttribute(
      'href',
      '/search?q=free-name.com',
    )
  })

  it('still offers the search when the price list cannot be read', async () => {
    registry({ errorCode: 404 }, 404)
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    await renderFor('free-name.com')
    expect(screen.getByRole('link', { name: /Register free-name\.com/ })).toBeInTheDocument()
  })

  it('says so when a free name is in an extension we do not sell', async () => {
    registry({ errorCode: 404 }, 404)
    vi.mocked(getPricedCatalogue).mockResolvedValue({ ...CATALOGUE, tlds: [] })
    await renderFor('free-name.com')

    expect(screen.getByText(/We don't sell \.com domains/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Register/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /See the extensions we sell/ })).toHaveAttribute(
      'href',
      '/pricing',
    )
  })

  it('explains an extension whose registry runs no RDAP, and offers a search', async () => {
    await renderFor('getpaid.co')
    expect(heading()).toHaveTextContent("We can't look up .co domains")
    expect(screen.getByRole('link', { name: /Check getpaid\.co/ })).toHaveAttribute(
      'href',
      '/search?q=getpaid.co',
    )
  })

  it('offers no search for an extension without RDAP that we do not sell', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue({ ...CATALOGUE, tlds: [] })
    await renderFor('getpaid.co')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('says the registry did not answer, with a way to try again', async () => {
    registry({ title: 'busy' }, 503)
    await renderFor('lockedbrand.com')

    expect(heading()).toHaveTextContent("The registry didn't answer")
    expect(screen.getByRole('link', { name: /Try again/ })).toHaveAttribute(
      'href',
      '/whois?domain=lockedbrand.com#result',
    )
  })
})
