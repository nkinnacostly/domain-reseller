import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { CartAddView } from '../components/cart-add-view'
import { cartAddHref, MAX_LINK_DOMAINS, parseCartAddParam } from '../lib/add-link'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../components/cart-link-add', () => ({
  CartLinkAdd: ({ domains }: { domains: readonly string[] }) => <p>add {domains.join(' ')}</p>,
}))

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record: TldRecord = {
  name: 'ng',
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: true,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
}

describe('cart links (feature 8)', () => {
  it('round-trips names, lower-cased, distinct and capped', () => {
    expect(cartAddHref(['getpaid.ng', 'b.ng'])).toBe('/cart/add?d=getpaid.ng,b.ng')
    expect(parseCartAddParam(' GetPaid.ng ,getpaid.ng,,x')).toEqual(['getpaid.ng'])
    expect(parseCartAddParam(['a.ng', 'b.ng'])).toEqual(['a.ng', 'b.ng'])
    expect(
      parseCartAddParam(Array.from({ length: 30 }, (_, i) => `n${i}.ng`).join(',')),
    ).toHaveLength(MAX_LINK_DOMAINS)
    expect(parseCartAddParam(undefined)).toEqual([])
  })

  it('lists each name with its price and renewal, adds only what we sell, and nothing until pressed', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue({
      tlds: priceCatalogue([record], INPUTS),
      featured: [],
      effectiveRate: 1334,
      rateSource: 'test',
      rateUpdatedAt: new Date(),
      rateId: 'rate-1',
      vatPct: 7.5,
      version: 'test',
    })
    render(await CartAddView({ searchParams: Promise.resolve({ d: 'getpaid.ng,thing.zz' }) }))
    expect(screen.getByText(/₦[\d,]+ for the first year, then ₦[\d,]+ a year/)).toBeInTheDocument()
    expect(screen.getByText('Not a domain we sell')).toBeInTheDocument()
    expect(screen.getByText('add getpaid.ng')).toBeInTheDocument()
  })

  it('says so when the link is empty or prices are withheld', async () => {
    render(await CartAddView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText('This link has no domains in it.')).toBeInTheDocument()
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    render(await CartAddView({ searchParams: Promise.resolve({ d: 'getpaid.ng' }) }))
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
