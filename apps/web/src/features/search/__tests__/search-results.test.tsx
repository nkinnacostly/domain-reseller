import { type PricingInputs, priceCatalogue, type TldPricing, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { createServiceClient } from '@/lib/supabase/service'
import { server } from '../../../../tests/mocks/server'
import {
  BulkSearchLink,
  SearchHeading,
  SearchHeadingSkeleton,
  SearchResults,
} from '../components/search-results'
import { getLengthRules } from '../queries/length-rules'

// env.ts reads process.env once, at import: point it at a test gateway first.
vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../queries/length-rules', () => ({ getLengthRules: vi.fn() }))
// SEC-9: each search is counted per address, in the rate-limit table.
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '102.89.1.2' }),
  cookies: async () => ({ get: () => undefined }),
}))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

const rateLimit = (withinLimit: boolean) => {
  const rpc = vi.fn(async () => ({ data: withinLimit, error: null }))
  vi.mocked(createServiceClient).mockReturnValue({ rpc } as never)
  return rpc
}

// Fixed inputs so expectations do not move with the live rate.
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const record = (name: string, registerUsd: number, renewUsd: number): TldRecord => ({
  name,
  registerUsd,
  renewUsd,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})

const tlds = priceCatalogue(
  [record('com', 11.31, 11.51), record('africa', 14, 16), record('net', 12, 14)],
  INPUTS,
)
const CATALOGUE: PricedCatalogue = {
  tlds,
  featured: tlds.map((tld) => ({ ...tld, tagline: null })),
  effectiveRate: 1334,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

type Q = string | string[] | undefined
const params = (q: Q) => Promise.resolve(q === undefined ? {} : { q })

/**
 * Resolves nested async Server Components the way the server does before it
 * streams them, so the test sees what a visitor ends up with. React's client
 * renderer refuses async components, and would leave the skeletons up.
 */
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer))
  if (!isValidElement<{ children?: ReactNode }>(node)) return node
  const { type, props } = node
  if (typeof type === 'function' && type.constructor.name === 'AsyncFunction') {
    return resolveServer(await (type as (p: unknown) => Promise<ReactNode>)(props))
  }
  if (props.children === undefined) return node
  const children = await resolveServer(props.children)
  return Array.isArray(children)
    ? cloneElement(node, undefined, ...children)
    : cloneElement(node, undefined, children)
}

async function renderResults(q: Q) {
  return render(await resolveServer(await SearchResults({ searchParams: params(q) })))
}

beforeEach(() => {
  vi.mocked(getPricedCatalogue).mockReset()
  vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
  vi.mocked(getLengthRules).mockResolvedValue({})
  rateLimit(true)
})

/** Records every availability request the gateway receives. */
function recordGateway() {
  const asked: { names: string[]; tlds: string[] }[] = []
  server.use(
    http.post('*/v1/availability', async ({ request }) => {
      const body = (await request.json()) as { names: string[]; tlds: string[] }
      asked.push(body)
      return HttpResponse.json({
        ok: true,
        data: {
          results: body.names.flatMap((name) =>
            body.tlds.map((tld) => ({ name, tld, domain: `${name}.${tld}`, status: 'available' })),
          ),
        },
      })
    }),
  )
  return asked
}

describe('SearchHeading', () => {
  it('names what was searched for, normalised', async () => {
    render(await SearchHeading({ searchParams: params('GetPaid.com') }))

    expect(
      screen.getByRole('heading', { level: 1, name: 'Results for getpaid.com' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Find your domain')).not.toHaveFocus()
  })

  it('reads the first query when the URL repeats it', async () => {
    render(await SearchHeading({ searchParams: params(['getpaid', 'other.net']) }))

    expect(
      screen.getByRole('heading', { level: 1, name: 'Results for getpaid' }),
    ).toBeInTheDocument()
  })

  it('invites a search, and focuses the field, when there is nothing to show', async () => {
    render(await SearchHeading({ searchParams: params(undefined) }))

    expect(
      screen.getByRole('heading', { level: 1, name: 'Search for a domain' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Find your domain')).toHaveFocus()
  })

  it('has a placeholder that is hidden from assistive tech while it loads', () => {
    const { container } = render(<SearchHeadingSkeleton />)

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('SearchResults', () => {
  it('asks for a name, without reading prices, when the query is empty', async () => {
    await renderResults('   ')

    expect(screen.getByText('Type a name above to get started')).toBeInTheDocument()
    expect(getPricedCatalogue).not.toHaveBeenCalled()
  })

  it('explains what a domain looks like when the query is not one', async () => {
    await renderResults('not a domain!')

    expect(screen.getByText("That doesn't look like a domain")).toBeInTheDocument()
    expect(screen.getByText(/for example getpaid or getpaid\.com/)).toBeInTheDocument()
  })

  it('does not count a query that is never searched against the allowance (SEC-9)', async () => {
    const rpc = rateLimit(true)
    await renderResults('not a domain!')
    await renderResults('')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('past the allowance, with no check to offer, asks the supplier nothing and says to wait (SEC-9)', async () => {
    const asked = recordGateway()
    const rpc = rateLimit(false)

    await renderResults('getpaid.com')

    expect(rpc).toHaveBeenCalledWith('rate_limit_hit', expect.objectContaining({ p_max: 30 }))
    expect(screen.getByRole('status')).toHaveTextContent(
      'You’ve searched a lot in the last few minutes',
    )
    expect(screen.getByRole('status')).toHaveTextContent('Wait a few minutes, then search again.')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(asked).toEqual([])
  })

  it('counts a search once, against a hash of the address (SEC-9)', async () => {
    const rpc = rateLimit(true)
    await renderResults('getpaid.com')

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('rate_limit_hit', {
      p_key: expect.stringMatching(/^search:[0-9a-f]{32}$/),
      p_max: 30,
      p_window_seconds: 600,
    })
  })

  it('shows no results at all when prices are withheld, since a result needs a price (N8)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    await renderResults('getpaid.com')

    expect(screen.getByRole('status')).toHaveTextContent('Prices are briefly unavailable')
    expect(screen.queryByText(/on other extensions/)).not.toBeInTheDocument()
  })

  it('streams in the exact match with both prices, the other extensions and the alternatives', async () => {
    await renderResults('getpaid.com')

    const com = toPublicRow(tlds[0] as TldPricing)
    const exact = screen.getByRole('article', { name: 'getpaid.com' })
    expect(exact).toHaveTextContent('Exact match')
    expect(exact).toHaveTextContent(com.register)
    expect(exact).toHaveTextContent(`${com.renew}/yr`)
    expect(
      within(screen.getByRole('list', { name: 'getpaid on other extensions' })).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(2)
    expect(screen.getByRole('list', { name: 'Available alternatives' })).toBeInTheDocument()
    expect(screen.getByText(/We never sell or share what you search for/)).toBeInTheDocument()
  })

  it('says plainly when the typed extension is not one we sell, and shows the ones we do', async () => {
    await renderResults('getpaid.xyz')

    expect(
      screen.getByRole('heading', { level: 2, name: "We don't sell .xyz" }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Here is getpaid on the extensions we do sell/)).toBeInTheDocument()
    const grid = screen.getByRole('list', { name: 'getpaid on other extensions' })
    expect(within(grid).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('explains a lookalike name mixing alphabets, rather than searching it (FR-S8)', async () => {
    // The second letter is Cyrillic а.
    await renderResults('pаypal.com')

    expect(screen.getByText('That name mixes alphabets')).toBeInTheDocument()
    expect(screen.getByText(/different alphabets \(Latin and Cyrillic\)/)).toBeInTheDocument()
    expect(getPricedCatalogue).not.toHaveBeenCalled()
  })

  it('shows an international name as people read it, with the ASCII form beside it (FR-S8)', async () => {
    await renderResults('café.com')

    const exact = screen.getByRole('article', { name: 'café.com' })
    expect(exact).toHaveTextContent('xn--caf-dma.com')
    expect(screen.getByRole('button', { name: 'Add café.com to cart' })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'café on other extensions' })).toBeInTheDocument()
  })

  it('answers a name its extension is too short for without asking the supplier (FR-S9)', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({ africa: { min: 3, max: 63 } })
    const asked = recordGateway()

    await renderResults('ab.africa')

    const exact = screen.getByRole('article', { name: 'ab.africa' })
    expect(exact).toHaveTextContent('Not available')
    expect(exact).toHaveTextContent('Too short for .africa (3–63 characters).')
    expect(asked.some((body) => body.tlds.includes('africa') && body.names.includes('ab'))).toBe(
      false,
    )
  })

  it('shows a too-long extension in the grid without asking about it (FR-S9)', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({ net: { min: null, max: 5 } })
    const asked = recordGateway()

    await renderResults('getpaid.com')

    const grid = screen.getByRole('list', { name: 'getpaid on other extensions' })
    expect(within(grid).getByText('getpaid.net').closest('li')).toHaveTextContent(
      'Too long for .net (at most 5 characters)',
    )
    expect(asked.flatMap((body) => body.tlds)).not.toContain('net')
  })

  it('asks nothing for the grid when every other extension refuses the name (FR-S9)', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({
      africa: { min: 9, max: null },
      net: { min: 9, max: null },
    })
    const asked = recordGateway()

    await renderResults('getpaid.com')

    const grid = screen.getByRole('list', { name: 'getpaid on other extensions' })
    expect(within(grid).getAllByRole('listitem')).toHaveLength(2)
    expect(asked.flatMap((body) => body.tlds)).toEqual(['com', 'com', 'africa'])
  })
})

describe('BulkSearchLink', () => {
  it('points to bulk search from the search page (FR-S5)', () => {
    render(<BulkSearchLink />)
    expect(screen.getByRole('link', { name: 'Search many at once' })).toHaveAttribute(
      'href',
      '/search/bulk',
    )
  })
})
