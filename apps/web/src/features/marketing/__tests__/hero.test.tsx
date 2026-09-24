import { formatNaira, type PricingInputs, priceCatalogue, type TldPricing } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Hero } from '../components/hero'
import type { Quote } from '../components/phone-screens'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

// Fixed inputs so expectations do not move with the live rate.
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const [africa] = priceCatalogue(
  [
    {
      name: 'africa',
      registerUsd: 14,
      renewUsd: 16,
      transferUsd: null,
      restoreUsd: null,
      isCountryCode: false,
      minPeriod: 1,
      maxPeriod: 10,
      redemptionDays: 30,
      requiresExtraFields: false,
    },
  ],
  INPUTS,
) as [TldPricing]

const lead: Quote = {
  tld: africa.tld,
  firstYear: formatNaira(africa.registration.priceKobo),
  renewal: formatNaira(africa.renewal.priceKobo),
}

describe('Hero', () => {
  it('states the live extension count and the renewal promise', () => {
    render(<Hero extensionCount={1234} lead={lead} host="Vercel" />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'The domain you want, priced in naira' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Search 1,234 extensions, from \.com to \.africa\./)).toHaveTextContent(
      /renewal price sits next to the first-year price/,
    )
  })

  it('does not invent a number when the catalogue count is unknown', () => {
    render(<Hero extensionCount={null} lead={null} host={null} />)

    expect(screen.getByText(/Search hundreds of extensions\./)).toBeInTheDocument()
    expect(screen.queryByText(/Search \d/)).not.toBeInTheDocument()
  })

  it('leads with the search form', () => {
    render(<Hero extensionCount={1234} lead={lead} host="Vercel" />)

    const form = screen.getByRole('form', { name: 'Domain search' })
    expect(within(form).getByLabelText('Find your domain')).toBeInTheDocument()
  })

  it('shows the lead extension with its live renewal price on the phone (N8)', () => {
    render(<Hero extensionCount={1234} lead={lead} host="Vercel" />)

    const phone = screen.getByTestId('hero-phone')
    expect(phone).toHaveAttribute('aria-hidden', 'true')
    expect(phone).toHaveTextContent('getpaid.africa')
    expect(phone).toHaveTextContent(`${lead.renewal}/yr`)
    expect(phone).toHaveTextContent('Vercel')
  })
})
