import {
  formatNaira,
  type PricingInputs,
  priceCatalogue,
  type TldPricing,
  type TldRecord,
  vatKobo,
} from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HowItWorks } from '../components/how-it-works'
import type { Quote } from '../components/phone-screens'

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

const quote = (pricing: TldPricing): Quote => ({
  tld: pricing.tld,
  firstYear: formatNaira(pricing.registration.priceKobo),
  renewal: formatNaira(pricing.renewal.priceKobo),
})

const [comPricing, africaPricing] = priceCatalogue(
  [record('com', 11.31, 11.51), record('africa', 14, 16)],
  INPUTS,
) as [TldPricing, TldPricing]
const lead = quote(comPricing)
const more = [quote(africaPricing)]
const firstYearKobo = comPricing.registration.priceKobo
const vat = {
  pct: 7.5,
  amount: formatNaira(vatKobo(firstYearKobo, 7.5)),
  total: formatNaira(firstYearKobo + vatKobo(firstYearKobo, 7.5)),
}

const props = {
  lead,
  more,
  vat,
  hosts: ['Vercel', 'Hostinger', 'Truehost Nigeria'],
  extensionCount: 812,
  holdMinutes: 30,
}

describe('HowItWorks', () => {
  it('walks through search, pay and point, in that order', () => {
    render(<HowItWorks {...props} />)

    expect(
      screen.getByRole('heading', { level: 2, name: 'Three steps, no tutorial' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Search once, see both prices',
      'Pay in naira, your way',
      'Point it at your host',
    ])
    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.getByText('Step 3')).toBeInTheDocument()
  })

  it('links each step to where it is explained', () => {
    render(<HowItWorks {...props} />)

    expect(screen.getByRole('link', { name: 'See all prices' })).toHaveAttribute('href', '/pricing')
    expect(screen.getByRole('link', { name: 'How buying works' })).toHaveAttribute(
      'href',
      '/help#buying',
    )
    expect(screen.getByRole('link', { name: 'How pointing works' })).toHaveAttribute(
      'href',
      '/help#pointing',
    )
  })

  it('states only what the product does: the live count, the price hold, the verified hosts', () => {
    render(<HowItWorks {...props} />)

    expect(screen.getByText('812 extensions, from .com to .africa')).toBeInTheDocument()
    expect(
      screen.getByText('Your price is held for 30 minutes once it is in your cart'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Ready-made for Vercel, Hostinger and Truehost Nigeria'),
    ).toBeInTheDocument()
    expect(screen.getByText('First-year and renewal price on every result')).toBeInTheDocument()
  })

  it('falls back to plain claims when there is no count and no host preset', () => {
    render(<HowItWorks {...props} extensionCount={null} hosts={[]} />)

    expect(screen.getByText('Every extension we carry, in one search')).toBeInTheDocument()
    expect(screen.getByText('Paste the nameservers your host gave you')).toBeInTheDocument()
    expect(screen.queryByText(/Ready-made for/)).not.toBeInTheDocument()
  })

  it('shows live first-year and renewal prices on the search phone (N8)', () => {
    render(<HowItWorks {...props} />)

    const phone = screen.getByTestId('search-phone')
    const leadQuote = within(phone).getByTestId('search-quote')
    expect(leadQuote).toHaveTextContent(lead.firstYear)
    expect(leadQuote).toHaveTextContent(`${lead.renewal}/yr`)
    expect(phone).toHaveTextContent(`renews ${more[0]?.renewal}/yr`)
  })
})
