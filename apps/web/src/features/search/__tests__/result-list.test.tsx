import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { type PublicPriceRow, toPublicRow } from '@/features/pricing/lib/public-row'
import { ResultItem, ResultList } from '../components/result-list'
import { lengthRow, toSearchRows } from '../lib/rows'

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

const prices = new Map(
  priceCatalogue([record('com', 11.31, 11.51), record('io', 30, 30)], INPUTS).map((pricing) => [
    pricing.tld,
    toPublicRow(pricing),
  ]),
)
const price = (tld: string) => prices.get(tld) as PublicPriceRow

const rows = toSearchRows(
  [
    { name: 'getpaid', tld: 'com', domain: 'getpaid.com', status: 'available' },
    { name: 'getpaid', tld: 'io', domain: 'getpaid.io', status: 'registered' },
    // Renews at the same price as the first year.
    { name: 'trygetpaid', tld: 'io', domain: 'trygetpaid.io', status: 'available' },
    // Available, but the catalogue has no price for it.
    { name: 'getpaid', tld: 'xyz', domain: 'getpaid.xyz', status: 'available' },
    { name: 'getpaid', tld: 'io', domain: 'getpaid.co.io', status: 'unknown' },
  ],
  prices,
)

const item = (domain: string) =>
  within(screen.getByRole('list', { name: 'getpaid on other extensions' }))
    .getByText(domain)
    .closest('li') as HTMLElement

describe('ResultList', () => {
  it('shows an available name with its first-year and renewal price, and a way to buy it (N8)', () => {
    render(<ResultList rows={rows} label="getpaid on other extensions" />)

    const com = item('getpaid.com')
    expect(com).toHaveTextContent('Available')
    expect(com).toHaveTextContent(price('com').register)
    expect(com).toHaveTextContent(`then ${price('com').renew}/yr`)
    expect(within(com).getByRole('button', { name: 'Add getpaid.com to cart' })).toBeEnabled()
  })

  it('shows the renewal price even when it is no higher than the first year (N8)', () => {
    render(<ResultList rows={rows} label="getpaid on other extensions" />)

    const io = item('trygetpaid.io')
    expect(price('io').renewalIsHigher).toBe(false)
    expect(io).toHaveTextContent(price('io').register)
    expect(io).toHaveTextContent(`then ${price('io').renew}/yr`)
  })

  it('states a taken or unchecked name in words, with no price and no cart button', () => {
    render(<ResultList rows={rows} label="getpaid on other extensions" />)

    const taken = item('getpaid.io')
    expect(taken).toHaveTextContent('Taken')
    expect(taken).not.toHaveTextContent('₦')
    expect(within(taken).queryByRole('button')).not.toBeInTheDocument()

    expect(item('getpaid.co.io')).toHaveTextContent("Couldn't check")
  })

  it('does not offer an available name the catalogue cannot price (N5b)', () => {
    render(<ResultList rows={rows} label="getpaid on other extensions" />)

    const unpriced = item('getpaid.xyz')
    expect(unpriced).toHaveTextContent('Available')
    expect(unpriced).not.toHaveTextContent('₦')
    expect(within(unpriced).queryByRole('button')).not.toBeInTheDocument()
  })

  it('names the list, so two lists on one page can be told apart', () => {
    render(<ResultList rows={[]} label="More available alternatives" />)

    expect(screen.getByRole('list', { name: 'More available alternatives' })).toBeEmptyDOMElement()
  })

  it('shows an international name as read, its ASCII form beside it, and names the button so (FR-S8)', () => {
    const [idn] = toSearchRows(
      [{ name: 'xn--caf-dma', tld: 'com', domain: 'xn--caf-dma.com', status: 'available' }],
      prices,
    )
    render(<ResultList rows={idn ? [idn] : []} label="Results" />)

    const row = screen.getByRole('listitem')
    expect(row.querySelector('span')).toHaveTextContent('café.com')
    expect(row).toHaveTextContent('Also written as xn--caf-dma.com')
    expect(within(row).getByRole('button', { name: 'Add café.com to cart' })).toBeEnabled()
  })

  it('says why a name was refused when there is a reason to give (FR-S9)', () => {
    render(
      <ResultList
        rows={[lengthRow('ab', 'io', { kind: 'too-short', min: 3, max: 63 })]}
        label="Results"
      />,
    )

    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('Not available')
    expect(row).toHaveTextContent('Too short for .io (3–63 characters)')
    expect(within(row).queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('ResultItem — lookalikes (FR-S8)', () => {
  const [lookalike] = toSearchRows(
    // аррӏе — Cyrillic letters that read as "apple".
    [{ name: 'xn--80ak6aa92e', tld: 'com', domain: 'xn--80ak6aa92e.com', status: 'available' }],
    prices,
  )

  it('warns when asked, in a row that stands for its own name', () => {
    render(<ul>{lookalike ? <ResultItem row={lookalike} lookalike /> : null}</ul>)
    expect(screen.getByRole('listitem')).toHaveTextContent('Can pass for “apple”')
  })

  it('stays quiet otherwise, as in a grid of one name on many extensions', () => {
    render(<ul>{lookalike ? <ResultItem row={lookalike} /> : null}</ul>)
    expect(screen.getByRole('listitem')).not.toHaveTextContent('Can pass for')
  })
})
