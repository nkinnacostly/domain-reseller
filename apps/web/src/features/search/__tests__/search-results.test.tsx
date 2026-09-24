import { type PricingInputs, priceCatalogue, type TldPricing, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { SearchHeading, SearchHeadingSkeleton, SearchResults } from '../components/search-results'

// env.ts reads process.env once, at import: point it at a test gateway first.
vi.hoisted(() => {
  vi.stubEnv('GATEWAY_URL', 'http://gateway.test')
  vi.stubEnv('GATEWAY_SHARED_SECRET', 'test-secret-value-16')
})
afterAll(() => vi.unstubAllEnvs())

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))

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
})

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
})
