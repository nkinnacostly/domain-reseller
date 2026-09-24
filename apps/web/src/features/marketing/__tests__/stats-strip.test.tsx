import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { StatsStrip } from '../components/stats-strip'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))

// Fixed inputs so expectations do not move with the live rate.
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const record = (name: string, maxPeriod: number, redemptionDays: number): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: name.length === 2,
  minPeriod: 1,
  maxPeriod,
  redemptionDays,
  requiresExtraFields: false,
})

const tlds = priceCatalogue(
  [record('africa', 10, 30), record('com', 10, 30), record('ng', 5, 40)],
  INPUTS,
)

function catalogue(featured: string[]): PricedCatalogue {
  return {
    tlds,
    featured: featured.flatMap((name) => {
      const tld = tlds.find((t) => t.tld === name)
      return tld ? [{ ...tld, tagline: null }] : []
    }),
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  }
}

/** The value a stat states, found from its label (dt → dd). */
function stat(label: string) {
  const term = screen.getByText(label)
  const group = term.parentElement as HTMLElement
  return within(group).getByRole('definition').textContent
}

async function renderStrip() {
  return render(await StatsStrip())
}

beforeEach(() => vi.mocked(getPricedCatalogue).mockReset())

describe('StatsStrip', () => {
  it('reads every number from the live catalogue', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue(['ng', 'com']))
    await renderStrip()

    expect(screen.getByRole('region', { name: 'At a glance' })).toBeInTheDocument()
    expect(stat('Extensions available')).toBe('3')
    expect(stat('Longest registration term')).toBe('10 years')
    // The lead featured extension's own redemption window, not a generic claim.
    expect(stat('To recover an expired .ng')).toBe('40 days')
    expect(stat('Hidden fees at checkout')).toBe('0')
  })

  it('drops the recovery stat when nothing is featured', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue([]))
    await renderStrip()

    expect(stat('Extensions available')).toBe('3')
    expect(screen.queryByText(/To recover an expired/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('definition')).toHaveLength(3)
  })

  it('states only the fee promise when prices are withheld, never a stale count', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    await renderStrip()

    expect(screen.getAllByRole('definition')).toHaveLength(1)
    expect(stat('Hidden fees at checkout')).toBe('0')
    expect(screen.queryByText('Extensions available')).not.toBeInTheDocument()
  })
})
