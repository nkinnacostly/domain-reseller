import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FeaturedPricing } from '../components/featured-pricing'
import { PricingUnavailable } from '../components/pricing-unavailable'
import { type PublicPriceRow, toPublicRow } from '../lib/public-row'

// Fixed inputs so expectations do not move with the live rate.
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const record = (
  name: string,
  registerUsd: number,
  renewUsd: number,
  overrides: Partial<TldRecord> = {},
): TldRecord => ({
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
  ...overrides,
})

const rows = priceCatalogue(
  [
    // A promotional first year: renews higher.
    record('africa', 4, 16),
    // Same cost both years.
    record('com', 11.31, 11.31),
    record('ng', 8, 8, { isCountryCode: true, maxPeriod: 5 }),
  ],
  INPUTS,
).map(toPublicRow)
const [africa, com, ng] = rows as [PublicPriceRow, PublicPriceRow, PublicPriceRow]

const card = (tld: string) =>
  within(screen.getByRole('list', { name: 'Featured extensions' }))
    .getByText(tld)
    .closest('li') as HTMLElement

describe('FeaturedPricing', () => {
  it('shows each featured extension, in the order given', () => {
    render(<FeaturedPricing rows={rows} label="Featured extensions" />)

    const list = screen.getByRole('list', { name: 'Featured extensions' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.firstChild?.textContent),
    ).toEqual(['.africa', '.com', '.ng'])
  })

  it('puts the renewal price on every card, and calls out a higher one (N8)', () => {
    render(<FeaturedPricing rows={rows} label="Featured extensions" />)

    expect(africa.renewalIsHigher).toBe(true)
    expect(card('.africa')).toHaveTextContent(`${africa.register}/yr`)
    expect(card('.africa')).toHaveTextContent(`Renews at ${africa.renew}/yr`)
  })

  it('says so plainly when the renewal costs the same as the first year', () => {
    render(<FeaturedPricing rows={rows} label="Featured extensions" />)

    expect(com.renew).toBe(com.register)
    expect(within(card('.com')).getByText('Renews at the same price')).toBeInTheDocument()
  })

  it('says whether the ICANN fee applies, and how long it can be registered for', () => {
    render(<FeaturedPricing rows={rows} label="Featured extensions" />)

    expect(card('.com')).toHaveTextContent('Up to 10 years · ICANN fee included')
    expect(card('.ng')).toHaveTextContent(`${ng.register}/yr`)
    expect(card('.ng')).toHaveTextContent('Up to 5 years · no ICANN fee')
  })

  it('renders nothing when no extension is featured', () => {
    const { container } = render(<FeaturedPricing rows={[]} label="Featured extensions" />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('PricingUnavailable', () => {
  it('withholds prices with an explanation, announced politely', () => {
    render(<PricingUnavailable />)

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Prices are briefly unavailable')
    expect(status).toHaveTextContent(/rather show you nothing than show you the wrong figure/)
    expect(status).not.toHaveTextContent('₦')
  })
})
