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
import { TransferPrices } from '../components/transfer-prices'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))

// Fixed inputs so expectations do not move with the live rate.
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const record = (name: string, transferUsd: number | null): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})

const tlds = priceCatalogue(
  [record('com', 10.61), record('africa', 16), record('noxfer', null)],
  INPUTS,
)
const pricing = (tld: string) => tlds.find((t) => t.tld === tld) as TldPricing

function catalogue(featured: string[]): PricedCatalogue {
  return {
    tlds,
    featured: featured.map((tld) => ({ ...pricing(tld), tagline: null })),
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  }
}

beforeEach(() => vi.mocked(getPricedCatalogue).mockReset())

describe('TransferPrices', () => {
  it('shows each featured transfer price with the renewal beside it (N8)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue(['africa', 'com']))
    render(await TransferPrices())

    const list = screen.getByRole('list', { name: 'Transfer prices' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.firstChild?.textContent)).toEqual(['.africa', '.com'])

    const com = pricing('com')
    const card = items[1] as HTMLElement
    expect(card).toHaveTextContent(formatNaira(com.transfer?.priceKobo ?? 0))
    expect(card).toHaveTextContent(`Renews at ${formatNaira(com.renewal.priceKobo)}/yr`)
  })

  it('leaves out an extension the registry quotes no transfer price for', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue(['com', 'noxfer']))
    render(await TransferPrices())

    const list = screen.getByRole('list', { name: 'Transfer prices' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByText('.noxfer')).not.toBeInTheDocument()
  })

  it('links to every extension on the pricing page', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue(['com']))
    render(await TransferPrices())

    expect(screen.getByRole('link', { name: 'Every extension' })).toHaveAttribute(
      'href',
      '/pricing',
    )
  })

  it.each([
    ['prices are withheld', null],
    ['no featured extension has a transfer price', catalogue(['noxfer'])],
  ])('withholds the list when %s', async (_, priced) => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(priced)
    render(await TransferPrices())

    expect(
      screen.getByRole('heading', { level: 2, name: 'What a transfer costs' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Prices are briefly unavailable')
    expect(screen.queryByRole('list', { name: 'Transfer prices' })).not.toBeInTheDocument()
  })
})
