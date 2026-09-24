import {
  formatNaira,
  type PricingInputs,
  priceCatalogue,
  type TldPricing,
  type TldRecord,
} from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { PopularExtensions } from '../components/popular-extensions'

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
  [
    record('africa', 4, 16),
    record('ai', 70, 70),
    record('app', 14, 14),
    record('com', 11.31, 11.51),
    record('dev', 13, 13),
    record('io', 30, 30),
    record('net', 12, 14),
  ],
  INPUTS,
)
const pricing = (tld: string) => tlds.find((t) => t.tld === tld) as TldPricing

function catalogue(featured: [string, string | null][]): PricedCatalogue {
  return {
    tlds,
    featured: featured.map(([tld, tagline]) => ({ ...pricing(tld), tagline })),
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  }
}

const card = (tld: string) => screen.getByRole('link', { name: new RegExp(`^\\.${tld}\\b`) })

beforeEach(() => vi.mocked(getPricedCatalogue).mockReset())

describe('PopularExtensions', () => {
  it('puts the renewal price on every card, beside the first-year price (N8)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(
      catalogue([
        ['com', 'The one everybody types first'],
        ['africa', null],
      ]),
    )
    render(await PopularExtensions())

    for (const tld of ['com', 'africa']) {
      const link = card(tld)
      expect(link).toHaveTextContent(`${formatNaira(pricing(tld).registration.priceKobo)}/yr`)
      expect(link).toHaveTextContent(`Renews at ${formatNaira(pricing(tld).renewal.priceKobo)}/yr`)
    }
    expect(card('com')).toHaveTextContent('The one everybody types first')
  })

  it("opens each extension's own page (FR-PUB1)", async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue([['com', null]]))
    render(await PopularExtensions())

    expect(card('com')).toHaveAttribute('href', '/domains/com')
    expect(screen.getByRole('link', { name: `See all ${tlds.length} prices` })).toHaveAttribute(
      'href',
      '/pricing',
    )
  })

  it('shows the first six featured extensions, in rank order', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(
      catalogue([
        ['net', null],
        ['com', null],
        ['africa', null],
        ['io', null],
        ['ai', null],
        ['app', null],
        ['dev', null],
      ]),
    )
    render(await PopularExtensions())

    const list = screen.getByRole('list')
    expect(
      within(list)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['.net', '.com', '.africa', '.io', '.ai', '.app'])
  })

  it('withholds the cards but still links to every price when nothing is featured', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue([]))
    render(await PopularExtensions())

    expect(screen.getByRole('status')).toHaveTextContent('Prices are briefly unavailable')
    expect(screen.getByRole('link', { name: /See all \d+ prices/ })).toBeInTheDocument()
  })

  it('shows no prices and no count when prices are withheld (N5b)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    render(await PopularExtensions())

    expect(
      screen.getByRole('heading', { level: 2, name: 'Popular extensions' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Prices are briefly unavailable')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })
})
