import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ExactResult } from '../components/exact-result'
import type { SearchRow } from '../lib/rows'

const row = (overrides: Partial<SearchRow> = {}): SearchRow => ({
  domain: 'getpaid.com',
  name: 'getpaid',
  tld: 'com',
  status: 'available',
  price: {
    register: '₦18,400',
    renew: '₦18,700',
    renewalIsHigher: true,
    includesIcannFee: true,
    maxPeriod: 10,
  },
  ...overrides,
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
})
