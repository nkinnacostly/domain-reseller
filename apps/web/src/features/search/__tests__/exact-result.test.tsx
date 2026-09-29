import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ExactResult } from '../components/exact-result'
import { lengthRow, type SearchRow } from '../lib/rows'

const row = (overrides: Partial<SearchRow> = {}): SearchRow => ({
  domain: 'getpaid.com',
  display: 'getpaid.com',
  name: 'getpaid',
  tld: 'com',
  status: 'available',
  price: {
    register: '₦18,400',
    registerYears: 1,
    renew: '₦18,700',
    renewYears: 1,
    renewalIsHigher: true,
    includesIcannFee: true,
    maxPeriod: 10,
  },
  ...overrides,
})

/** .ai as the search shows it: its two-year minimum, renewing every two years. */
const ai = (): SearchRow =>
  row({
    domain: 'getpaid.ai',
    display: 'getpaid.ai',
    tld: 'ai',
    price: {
      register: '₦273,000',
      registerYears: 2,
      renew: '₦273,000',
      renewYears: 2,
      renewalIsHigher: false,
      includesIcannFee: false,
      maxPeriod: 10,
    },
  })

describe('ExactResult', () => {
  it('shows the first-year and renewal price together (N8, FR-S2)', () => {
    render(<ExactResult row={row()} />)
    expect(screen.getByRole('heading', { name: 'getpaid.com' })).toBeInTheDocument()
    expect(screen.getByText('₦18,400')).toBeInTheDocument()
    expect(screen.getByText('₦18,700/yr')).toBeInTheDocument()
    expect(screen.getByText(/higher than the first/)).toBeInTheDocument()
    expect(screen.getByText(/includes the ICANN fee/)).toBeInTheDocument()
  })

  it('keeps the one-year wording exactly as it was', () => {
    render(<ExactResult row={row()} />)
    expect(screen.getByText('first year')).toBeInTheDocument()
    expect(screen.getByText(/every year after — higher than the first/)).toBeInTheDocument()
    expect(screen.getByText(/register for up to 10 years/)).toBeInTheDocument()
  })

  it('states .ai’s real minimum charge and renewal, with no per-year price (N8, N9b)', () => {
    render(<ExactResult row={ai()} />)
    expect(screen.getByText('for 2 years — the shortest term .ai allows')).toBeInTheDocument()
    expect(screen.getByText('₦273,000 every 2 years')).toBeInTheDocument()
    expect(screen.getByText('after the first 2 years')).toBeInTheDocument()
    expect(screen.getByRole('article')).not.toHaveTextContent(/\/yr|first year/)
  })

  it('offers a transfer check for a taken name, since it may be theirs', () => {
    render(<ExactResult row={row({ status: 'registered' })} />)
    expect(screen.getByText('Taken')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /check whether it can transfer/i })).toHaveAttribute(
      'href',
      '/transfer?domain=getpaid.com#check',
    )
    expect(screen.queryByText('₦18,400')).not.toBeInTheDocument()
  })

  it.each([
    ['premium', /own premium price/],
    ['restricted', /cannot be registered/],
    ['unknown', /did not answer in time/],
  ] as const)('explains a %s result and shows no price', (status, copy) => {
    render(<ExactResult row={row({ status })} />)
    expect(screen.getByText(copy)).toBeInTheDocument()
    expect(screen.queryByText('₦18,400')).not.toBeInTheDocument()
  })

  it('does not invent a price for an available name the catalogue cannot price', () => {
    render(<ExactResult row={row({ price: null })} />)
    expect(screen.getByText(/cannot show a price/)).toBeInTheDocument()
  })

  it('leads with an international name as read, with its ASCII form (FR-S8)', () => {
    render(
      <ExactResult
        row={row({ domain: 'xn--caf-dma.com', display: 'café.com', name: 'xn--caf-dma' })}
      />,
    )
    expect(screen.getByRole('heading', { name: 'café.com' })).toBeInTheDocument()
    expect(screen.getByText('xn--caf-dma.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add café.com to cart' })).toBeInTheDocument()
  })

  it('warns that a Cyrillic name can pass for a Latin one (FR-S8)', () => {
    render(
      <ExactResult
        row={row({
          domain: 'xn--80ak6aa92e.com',
          display: 'аррӏе.com',
          name: 'xn--80ak6aa92e',
        })}
      />,
    )
    expect(screen.getByText(/Looks like “apple”/)).toBeInTheDocument()
    expect(screen.getByText(/written in Cyrillic letters that look like Latin ones/)).toBeVisible()
  })

  it('says an extension refused an international name, in its own words (FR-S8)', () => {
    render(
      <ExactResult
        row={row({
          domain: 'xn--caf-dma.africa',
          display: 'café.africa',
          name: 'xn--caf-dma',
          tld: 'africa',
          status: 'restricted',
          price: null,
        })}
      />,
    )
    expect(screen.getByText(/Not available for this extension/)).toBeInTheDocument()
    expect(screen.queryByText(/most often the minimum length/)).not.toBeInTheDocument()
  })

  it('names the length rule a name breaks (FR-S9)', () => {
    render(<ExactResult row={lengthRow('ab', 'io', { kind: 'too-short', min: 3, max: 63 })} />)
    expect(screen.getByText('Too short for .io (3–63 characters).')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
