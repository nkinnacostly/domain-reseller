import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { checkBulkNames } from '../actions/bulk'
import { BulkRunProvider } from '../components/bulk-run'
import { BulkSearchPanel, BulkSearchPanelSkeleton } from '../components/bulk-search-panel'
import { getLengthRules } from '../queries/length-rules'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../queries/length-rules', () => ({ getLengthRules: vi.fn() }))
vi.mock('../actions/bulk', () => ({ checkBulkNames: vi.fn() }))

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const TLDS = ['com', 'net', 'org', 'africa', 'io', 'co', 'app', 'dev', 'xyz']
const tlds = priceCatalogue(TLDS.map(record), INPUTS)
const CATALOGUE: PricedCatalogue = {
  tlds,
  // `edu` is featured but not sold: never offered.
  featured: [...tlds, { ...record('edu'), tld: 'edu' } as never].map((tld) => ({
    ...tld,
    tagline: null,
  })),
  effectiveRate: 1334,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

type Params = { names?: string | string[]; tld?: string | string[] }

async function panel(params: Params) {
  const element = await BulkSearchPanel({ searchParams: Promise.resolve(params) })
  return render(<BulkRunProvider>{element}</BulkRunProvider>)
}

beforeEach(() => {
  vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
  vi.mocked(getLengthRules).mockResolvedValue({})
  vi.mocked(checkBulkNames).mockReset()
  vi.mocked(checkBulkNames).mockResolvedValue({
    data: { ok: true, results: [], prices: {} },
  } as never)
})

describe('BulkSearchPanel (FR-S5)', () => {
  it('withholds the form when prices are unavailable (N5b, N8)', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    await panel({})

    expect(screen.getByText('Prices are briefly unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: 'Bulk search' })).not.toBeInTheDocument()
  })

  it('offers the featured extensions we sell, seven at most, with the lead one ticked', async () => {
    await panel({})

    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((box) => box.getAttribute('value'))).toEqual(TLDS.slice(0, 7))
    expect(screen.getByRole('checkbox', { name: '.com' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '.net' })).not.toBeChecked()
    expect(checkBulkNames).not.toHaveBeenCalled()
  })

  it('puts names sent before the page was ready back in the form, and checks them', async () => {
    await panel({ names: ['getpaid, other', 'third'], tld: ['net', 'edu'] })

    expect(screen.getByLabelText('Names to check')).toHaveValue('getpaid\nother\nthird')
    expect(screen.getByRole('checkbox', { name: '.net' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '.com' })).not.toBeChecked()
    await waitFor(() =>
      expect(checkBulkNames).toHaveBeenCalledWith({
        names: ['getpaid', 'other', 'third'],
        tlds: ['net'],
      }),
    )
  })

  it('reads one name and one extension from the address as well as lists', async () => {
    await panel({ names: 'getpaid', tld: 'com' })
    expect(screen.getByLabelText('Names to check')).toHaveValue('getpaid')
  })

  it('draws a placeholder the size of the form while it loads', () => {
    const { container } = render(<BulkSearchPanelSkeleton />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})
