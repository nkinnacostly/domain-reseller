import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionDetails } from '../components/extension-details'
import { ExtensionFaq } from '../components/extension-faq'
import { ExtensionPrices } from '../components/extension-prices'
import { MissingExtensionTitle } from '../components/missing-extension-title'
import {
  type ExtensionFacts,
  extensionFaqs,
  extensionPrices,
  factsFromPricing,
} from '../lib/extension'

let pathname = '/domains/ng'
vi.mock('next/navigation', () => ({ usePathname: () => pathname }))

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string, overrides: Partial<TldRecord> = {}): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: 10.61,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
  ...overrides,
})
const [COM, PROMO] = priceCatalogue(
  [record('com'), record('promo', { registerUsd: 2, renewUsd: 30, transferUsd: null })],
  INPUTS,
)
if (!COM || !PROMO) throw new Error('fixture catalogue did not price')

const facts = (overrides: Partial<ExtensionFacts> = {}): ExtensionFacts => ({
  ...factsFromPricing(COM),
  ...overrides,
})

describe('ExtensionPrices', () => {
  it('shows first-year, renewal and transfer prices at the same size (N8, FR-S2)', () => {
    const prices = extensionPrices(COM, null)
    render(<ExtensionPrices tld="com" prices={prices} vatPct={7.5} isCountryCode={false} />)

    const values = screen.getAllByRole('definition').filter((dd) => dd.textContent?.startsWith('₦'))
    expect(values.map((dd) => dd.textContent)).toEqual([
      prices?.register,
      prices?.renew,
      prices?.transfer,
    ])
    expect(new Set(values.map((dd) => dd.className)).size).toBe(1)
    expect(screen.getByText(/Before VAT at 7\.5%/)).toBeInTheDocument()
    expect(screen.getByText(/ICANN fee on generic extensions is already included/)).toBeVisible()
  })

  it('flags a higher renewal and an extension we cannot transfer in', () => {
    render(
      <ExtensionPrices
        tld="promo"
        prices={extensionPrices(PROMO, null)}
        vatPct={null}
        isCountryCode={true}
      />,
    )
    expect(screen.getByText('Every year after — more than the first year')).toBeVisible()
    expect(screen.getByText('—')).toBeVisible()
    expect(screen.getByText("We can't currently transfer .promo domains in")).toBeVisible()
    expect(screen.getByText(/carry no ICANN fee/)).toBeVisible()
  })

  it('withholds every price when there are none (N5b)', () => {
    render(<ExtensionPrices tld="com" prices={null} vatPct={null} isCountryCode={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('Prices are briefly unavailable')
    expect(screen.queryByText(/₦/)).not.toBeInTheDocument()
  })
})

describe('ExtensionDetails', () => {
  it('lists the rules the catalogue records, with the tagline', () => {
    render(
      <ExtensionDetails
        facts={facts({ tagline: 'The one everybody types first', minChars: 1, maxChars: 63 })}
        prices={extensionPrices(COM, null)}
      />,
    )

    expect(screen.getByRole('heading', { name: 'About .com' })).toBeInTheDocument()
    expect(screen.getByText('The one everybody types first.')).toBeInTheDocument()
    expect(screen.getByText(/generic extension \(gTLD\)/)).toBeInTheDocument()
    const rules = screen.getAllByRole('term').map((dt) => dt.textContent)
    expect(rules).toEqual([
      'Registration period',
      'Name length',
      'ICANN fee',
      'Eligibility',
      'Transfers in',
    ])
    expect(screen.getByText('1 to 63 characters before the dot.')).toBeInTheDocument()
  })

  it('leaves out what is not known yet, and transfers when prices are withheld', () => {
    render(<ExtensionDetails facts={facts({ tagline: 'Short.' })} prices={null} />)
    const rules = screen.getAllByRole('term').map((dt) => dt.textContent)
    expect(rules).not.toContain('Name length')
    expect(rules).not.toContain('Transfers in')
    expect(screen.getByText('Short.')).toBeInTheDocument()
  })

  it('says when we cannot transfer the extension in', () => {
    render(
      <ExtensionDetails facts={facts({ tld: 'promo' })} prices={extensionPrices(PROMO, null)} />,
    )
    expect(screen.getByText("We can't currently transfer .promo domains in.")).toBeVisible()
  })
})

describe('ExtensionFaq', () => {
  it('opens an answer built from the extension’s data', async () => {
    const user = userEvent.setup()
    const prices = extensionPrices(COM, null)
    render(<ExtensionFaq tld="com" faqs={extensionFaqs({ facts: facts(), prices, vatPct: 7.5 })} />)

    expect(screen.getByRole('heading', { name: '.com questions' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'How much is a .com domain?' }))
    expect(screen.getByText(new RegExp(`${prices?.renew} a year to renew`))).toBeVisible()
  })
})

describe('MissingExtensionTitle', () => {
  it('names the extension from the address', () => {
    pathname = '/domains/ng'
    render(<MissingExtensionTitle />)
    expect(screen.getByText("We don't sell .ng")).toBeInTheDocument()
  })

  it('falls back to plain words for an address that is not an extension', () => {
    pathname = '/domains/%%%'
    render(<MissingExtensionTitle />)
    expect(screen.getByText("We don't sell that extension")).toBeInTheDocument()
  })
})
