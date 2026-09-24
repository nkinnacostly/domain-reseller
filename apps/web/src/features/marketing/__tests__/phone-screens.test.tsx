import {
  formatNaira,
  type PricingInputs,
  priceCatalogue,
  type TldPricing,
  type TldRecord,
  vatKobo,
} from '@dr/shared'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PhoneFrame } from '../components/phone-frame'
import {
  CheckoutScreen,
  DomainsScreen,
  NameserverScreen,
  type Quote,
  SearchScreen,
} from '../components/phone-screens'

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

const priced = priceCatalogue(
  [record('africa', 14, 16), record('com', 11.31, 11.51), record('io', 30, 45)],
  INPUTS,
)
const [africa, com, io] = priced.map(quote) as [Quote, Quote, Quote]
const africaKobo = (priced[0] as TldPricing).registration.priceKobo

const VAT_PCT = 7.5
const vat = {
  pct: VAT_PCT,
  amount: formatNaira(vatKobo(africaKobo, VAT_PCT)),
  total: formatNaira(africaKobo + vatKobo(africaKobo, VAT_PCT)),
}

describe('PhoneFrame', () => {
  it('hides the whole mockup from assistive tech, since the page copy states every fact', () => {
    render(
      <PhoneFrame testId="demo-phone">
        <p>Screen</p>
      </PhoneFrame>,
    )
    const phone = screen.getByTestId('demo-phone')
    expect(phone).toHaveAttribute('aria-hidden', 'true')
    expect(phone).toHaveTextContent('9:41')
    expect(phone).toHaveTextContent('Screen')
  })
})

describe('DomainsScreen', () => {
  it('shows the example domain on the lead extension with what it renews at (N8)', () => {
    render(<DomainsScreen lead={africa} host="Vercel" />)
    expect(screen.getByText('getpaid.africa')).toBeInTheDocument()
    expect(screen.getByText('Renews at')).toBeInTheDocument()
    expect(screen.getByText(`${africa.renewal}/yr`)).toBeInTheDocument()
    expect(screen.getByText('Vercel')).toBeInTheDocument()
  })

  it('falls back to .com and a dash, never an invented price, when prices are withheld', () => {
    render(<DomainsScreen lead={null} host={null} />)
    expect(screen.getByText('getpaid.com')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('Your host')).toBeInTheDocument()
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })
})

describe('SearchScreen', () => {
  it('shows both prices on the lead result and on every other extension (N8)', () => {
    render(<SearchScreen lead={africa} more={[com, io]} />)

    const lead = screen.getByTestId('search-quote')
    expect(lead).toHaveTextContent('getpaid.africa')
    expect(lead).toHaveTextContent(africa.firstYear)
    expect(lead).toHaveTextContent(`${africa.renewal}/yr`)

    expect(screen.getByText('More extensions')).toBeInTheDocument()
    for (const other of [com, io]) {
      expect(screen.getByText(`getpaid.${other.tld}`)).toBeInTheDocument()
      expect(screen.getByText(`renews ${other.renewal}/yr`)).toBeInTheDocument()
    }
  })

  it('shows dashes and no other extensions when the catalogue has nothing to quote', () => {
    render(<SearchScreen lead={null} more={[]} />)

    const lead = screen.getByTestId('search-quote')
    expect(lead).toHaveTextContent('getpaid.com')
    expect(lead).not.toHaveTextContent('₦')
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.queryByText('More extensions')).not.toBeInTheDocument()
  })
})

describe('CheckoutScreen', () => {
  it('shows VAT as its own line and the renewal under the first year', () => {
    render(<CheckoutScreen lead={africa} vat={vat} />)

    expect(screen.getByText(`1 year · renews at ${africa.renewal}/yr`)).toBeInTheDocument()
    expect(screen.getByText(`VAT (${VAT_PCT}%)`)).toBeInTheDocument()
    expect(screen.getByText(vat.amount)).toBeInTheDocument()
    expect(screen.getByText(`Pay ${vat.total}`)).toBeInTheDocument()
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent(vat.total)
    for (const method of ['Card', 'Transfer', 'USSD']) {
      expect(screen.getByText(method)).toBeInTheDocument()
    }
  })

  it('shows dashes rather than a made-up total when VAT or prices are missing', () => {
    render(<CheckoutScreen lead={null} vat={null} />)

    expect(screen.getByText('getpaid.com')).toBeInTheDocument()
    expect(screen.getByText('1 year · renews at —')).toBeInTheDocument()
    expect(screen.getByText('VAT')).toBeInTheDocument()
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('—')
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })
})

describe('NameserverScreen', () => {
  it('offers up to four verified hosts plus "somewhere else", and shows the first as chosen', () => {
    render(
      <NameserverScreen
        lead={africa}
        hosts={['Vercel', 'Hostinger', 'Truehost Nigeria', 'Cloudflare', 'Netlify']}
      />,
    )

    expect(screen.getByText('getpaid.africa')).toBeInTheDocument()
    const options = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(options).toEqual([
      'Vercel',
      'Hostinger',
      'Truehost Nigeria',
      'Cloudflare',
      'Somewhere else',
    ])
    expect(screen.getByText('What public resolvers see')).toBeInTheDocument()
    expect(screen.getByText('Vercel’s nameservers')).toBeInTheDocument()
  })

  it('without presets, offers only "somewhere else" and claims no resolver result', () => {
    render(<NameserverScreen lead={null} hosts={[]} />)

    expect(screen.getByText('getpaid.com')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Somewhere else',
    ])
    expect(screen.queryByText('What public resolvers see')).not.toBeInTheDocument()
  })
})
