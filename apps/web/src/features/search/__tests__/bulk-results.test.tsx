import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  Suspense,
} from 'react'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toPublicRow } from '@/features/pricing/lib/public-row'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { server } from '../../../../tests/mocks/server'
import { BulkResults, BulkSearchPanel, BulkSearchPanelSkeleton } from '../components/bulk-results'
import { bulkSearchAllowed } from '../queries/bulk-allowance'
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
vi.mock('../queries/bulk-allowance', () => ({ bulkSearchAllowed: vi.fn() }))
// The cart buttons' server actions are their network boundary.
vi.mock('@/features/cart/actions/cart', () => ({ addToCart: vi.fn(), addDomainsToCart: vi.fn() }))

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
  [record('com', 11.31, 11.51), record('net', 12, 14), record('io', 30, 30)],
  INPUTS,
)
const CATALOGUE: PricedCatalogue = {
  tlds,
  featured: tlds.slice(0, 2).map((tld) => ({ ...tld, tagline: null })),
  effectiveRate: 1334,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}
const com = toPublicRow(tlds[0] as (typeof tlds)[number])

type Params = { names?: string | string[]; tld?: string | string[] }
const params = (value: Params) => Promise.resolve(value)

/** Resolves nested async Server Components the way the server does before it streams them. */
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

/** The loading placeholders a visitor sees before each boundary resolves. */
function fallbacksOf(node: ReactNode): ReactNode[] {
  const found: ReactNode[] = []
  const walk = (current: ReactNode) => {
    Children.forEach(current, (child) => {
      if (!isValidElement<{ children?: ReactNode; fallback?: ReactNode }>(child)) return
      if (child.type === Suspense) found.push(child.props.fallback)
      walk(child.props.children)
    })
  }
  walk(node)
  return found
}

async function renderResults(value: Params) {
  return render(await resolveServer(await BulkResults({ searchParams: params(value) })))
}

/** Answers availability like the gateway: `taken*` names are registered, the rest free. */
function gateway(status?: number) {
  const asked: { names: string[]; tlds: string[]; priority?: string }[] = []
  server.use(
    http.post('*/v1/availability', async ({ request }) => {
      const body = (await request.json()) as { names: string[]; tlds: string[] }
      asked.push(body)
      if (status) {
        return HttpResponse.json(
          { ok: false, code: 'SUPPLIER_UNAVAILABLE', message: 'down', retryable: true },
          { status },
        )
      }
      return HttpResponse.json({
        ok: true,
        data: {
          results: body.names.flatMap((name) =>
            body.tlds.map((tld) => ({
              name,
              tld,
              domain: `${name}.${tld}`,
              status: name.startsWith('taken') ? 'registered' : 'available',
            })),
          ),
        },
      })
    }),
  )
  return asked
}

const rows = () => within(screen.getByRole('list', { name: 'Results, one row per name' }))
const row = (text: string) => rows().getByText(text).closest('li') as HTMLElement

beforeEach(() => {
  vi.mocked(getPricedCatalogue).mockReset()
  vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
  vi.mocked(getLengthRules).mockResolvedValue({})
  vi.mocked(bulkSearchAllowed).mockResolvedValue(true)
})

describe('BulkResults — before anything is asked', () => {
  it('invites a list when there is none, without reading prices', async () => {
    await renderResults({ names: ' \n ' })
    expect(screen.getByText('Paste a list to check it in one go')).toBeInTheDocument()
    expect(getPricedCatalogue).not.toHaveBeenCalled()
  })

  it('shows no results when prices are withheld, since a result needs a price (N8)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    await renderResults({ names: 'getpaid' })
    expect(screen.getByRole('status')).toHaveTextContent('Prices are briefly unavailable')
  })

  it('refuses a search over the per-address limit, and asks the registry nothing', async () => {
    vi.mocked(bulkSearchAllowed).mockResolvedValue(false)
    const asked = gateway()

    await renderResults({ names: 'getpaid\nmybrand' })

    expect(screen.getByRole('status')).toHaveTextContent("That's a lot of bulk searches")
    expect(asked).toEqual([])
  })

  it('does not count a list it can answer alone against the limit', async () => {
    const asked = gateway()
    await renderResults({ names: 'not_a_name\nschool.edu' })

    expect(bulkSearchAllowed).not.toHaveBeenCalled()
    expect(asked).toEqual([])
    expect(row('not_a_name')).toHaveTextContent('Not a domain')
    expect(row('school.edu')).toHaveTextContent("We don't sell .edu")
    expect(screen.getByRole('heading', { name: 'None of these are available' })).toBeVisible()
  })
})

describe('BulkResults — each line gets its own answer (FR-S5)', () => {
  it('answers every line in the order typed, with both prices on every free name (N8)', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({ io: { min: 3, max: 63 } })
    const asked = gateway()

    await renderResults({
      // The last line has a Cyrillic а.
      names: 'getpaid\ntakenbrand.net\ncafé.com\nab.io\nnot_a_name\nschool.edu\npаypal.com',
    })

    const texts = rows()
      .getAllByRole('listitem')
      .map((item) => item.querySelector('span')?.textContent)
    expect(texts).toEqual([
      'getpaid.com',
      'takenbrand.net',
      'café.com',
      'ab.io',
      'not_a_name',
      'school.edu',
      'pаypal.com',
    ])

    expect(row('getpaid.com')).toHaveTextContent(com.register)
    expect(row('getpaid.com')).toHaveTextContent(`then ${com.renew}/yr`)
    expect(
      within(row('getpaid.com')).getByRole('button', { name: 'Add getpaid.com to cart' }),
    ).toBeEnabled()
    expect(row('takenbrand.net')).toHaveTextContent('Taken')
    expect(row('café.com')).toHaveTextContent('xn--caf-dma.com')
    expect(
      within(row('café.com')).getByRole('button', { name: 'Add café.com to cart' }),
    ).toBeEnabled()
    expect(row('ab.io')).toHaveTextContent('Too short for .io (3–63 characters)')
    expect(row('pаypal.com')).toHaveTextContent('Mixes Latin and Cyrillic letters')

    // Never high priority, and never a name the extension refuses (FR-S9).
    expect(asked.every((body) => body.priority === 'normal')).toBe(true)
    expect(asked.some((body) => body.names.includes('ab'))).toBe(false)
  })

  it('tallies the answers and offers every free name in one press, nothing pre-ticked (N9)', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({ io: { min: 3, max: 63 } })
    gateway()

    await renderResults({ names: 'getpaid\ntakenbrand.net\ncafé.com\nab.io\nschool.edu' })

    expect(screen.getByRole('heading', { name: '2 of 5 available' })).toBeVisible()
    expect(screen.getByText('1 taken · 2 not available')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add all 2 available to cart' })).toBeEnabled()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('checks a bare name on each extension picked for it', async () => {
    gateway()
    await renderResults({ names: 'getpaid', tld: ['com', 'net'] })

    expect(row('getpaid.com')).toHaveTextContent('Available')
    expect(row('getpaid.net')).toHaveTextContent('Available')
    expect(screen.getByText('Every name is free to register.')).toBeVisible()
  })

  it('warns that a Cyrillic name can pass for a Latin one (FR-S8)', async () => {
    gateway()
    await renderResults({ names: 'аррӏе.com' })
    expect(row('аррӏе.com')).toHaveTextContent('Can pass for “apple”')
  })

  it('says which names it left out past the limit', async () => {
    gateway()
    const names = Array.from({ length: 22 }, (_, index) => `name${index}`).join('\n')
    await renderResults({ names })
    expect(
      screen.getByText('We checked the first 20 names. Search the other 2 separately.'),
    ).toBeVisible()
  })

  it('offers a retry, keeping the list, when the registry cannot be reached', async () => {
    gateway(502)
    await renderResults({ names: 'getpaid', tld: 'net' })

    expect(row('getpaid.net')).toHaveTextContent("Couldn't check")
    expect(screen.getByText("1 couldn't be checked")).toBeVisible()
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/search/bulk?names=getpaid&tld=net',
    )
    expect(screen.queryByRole('button', { name: /Add all/ })).not.toBeInTheDocument()
  })

  it('says a busy registry is the reason, when it is', async () => {
    server.use(
      http.post('*/v1/availability', () =>
        HttpResponse.json(
          { ok: false, code: 'RATE_LIMITED', message: 'busy', retryable: true },
          { status: 429 },
        ),
      ),
    )
    await renderResults({ names: 'getpaid' })
    expect(screen.getByText(/A lot of people are searching right now/)).toBeVisible()
  })

  it('shows each name, and how many it is checking, while the answers are on their way', async () => {
    const element = await BulkResults({ searchParams: params({ names: 'getpaid\nmybrand.net' }) })
    const [summary, ...pending] = fallbacksOf(element)
    render(
      <>
        {summary}
        <ul>{pending}</ul>
      </>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Checking 2 names on 2 extensions…')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'getpaid.comChecking',
      'mybrand.netChecking',
    ])
  })
})

describe('BulkSearchPanel', () => {
  it('offers the featured extensions, and keeps the list and choices from the last search', async () => {
    render(
      (await BulkSearchPanel({
        searchParams: params({ names: 'getpaid\nmybrand.com', tld: 'net' }),
      })) as ReactElement,
    )

    expect(screen.getByLabelText('Names to check')).toHaveValue('getpaid\nmybrand.com')
    expect(screen.getByRole('checkbox', { name: '.com' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '.net' })).toBeChecked()
  })

  it('still offers the form when prices are withheld', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    render((await BulkSearchPanel({ searchParams: params({}) })) as ReactElement)
    expect(screen.getByLabelText('Names to check')).toHaveValue('')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('has a placeholder hidden from assistive tech while it loads', () => {
    const { container } = render(<BulkSearchPanelSkeleton />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})
