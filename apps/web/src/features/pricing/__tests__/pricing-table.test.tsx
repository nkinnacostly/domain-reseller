import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PricingTable } from '../components/pricing-table'
import { type PublicPriceRow, toPublicRow } from '../lib/public-row'

// Fixed inputs so expectations do not move with the live rate.
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

/** 42 filler extensions, so the table has more than one page. */
const FILLER = Array.from({ length: 42 }, (_, i) => record(`ext${String(i + 10)}`))

const rows = priceCatalogue(
  [
    record('com'),
    record('africa', { registerUsd: 4, renewUsd: 16 }),
    record('ng', { isCountryCode: true, transferUsd: null, requiresExtraFields: true }),
    record('io', { registerUsd: 30, renewUsd: 30 }),
    ...FILLER,
  ],
  INPUTS,
).map(toPublicRow)
const TOTAL = rows.length
const byTld = (tld: string) => rows.find((row) => row.tld === tld) as PublicPriceRow

/**
 * The table row for an extension, found by its row header. The header's name
 * runs straight into its notes (".comincl. ICANN fee"), so match on the
 * extension itself rather than a name prefix — ".co" must not find ".com".
 */
function row(tld: string) {
  const header = screen
    .getAllByRole('rowheader')
    .find((th) => th.firstChild?.textContent === `.${tld}`)
  if (!header) throw new Error(`no row for .${tld}`)
  return header.closest('tr')
}

const bodyRows = () => screen.getAllByRole('rowheader')
const filter = () => screen.getByRole('searchbox', { name: 'Find an extension' })

describe('PricingTable', () => {
  it('lists first-year, renewal and transfer prices side by side (N8)', () => {
    render(<PricingTable rows={rows} />)

    expect(screen.getByRole('table', { name: /Domain prices by extension/ })).toBeInTheDocument()
    const com = byTld('com')
    const cells = within(row('com') as HTMLElement).getAllByRole('cell')
    expect(cells.map((cell) => cell.textContent)).toEqual([
      com.register,
      expect.stringContaining(com.renew),
      com.transfer,
      expect.stringMatching(/^Search/),
    ])
  })

  it('says when renewal costs more than the first year, in words as well as weight', () => {
    render(<PricingTable rows={rows} />)

    const africa = byTld('africa')
    expect(africa.renewalIsHigher).toBe(true)
    expect(within(row('africa') as HTMLElement).getAllByRole('cell')[1]).toHaveTextContent(
      `${africa.renew} — higher than the first year`,
    )
    expect(within(row('io') as HTMLElement).getAllByRole('cell')[1]).not.toHaveTextContent(
      'higher than the first year',
    )
  })

  it('marks the ICANN fee on gTLDs only, eligibility rules, and a missing transfer price', () => {
    render(<PricingTable rows={rows} />)

    expect(within(row('com') as HTMLElement).getByRole('rowheader')).toHaveTextContent(
      '.comincl. ICANN fee',
    )
    const ng = row('ng') as HTMLElement
    expect(within(ng).getByRole('rowheader')).not.toHaveTextContent('ICANN fee')
    expect(within(ng).getByRole('rowheader')).toHaveTextContent('Eligibility rules apply')
    expect(within(ng).getAllByRole('cell')[2]).toHaveTextContent('—')
  })

  it('links each row to a search on that extension, and can be linked to itself', () => {
    render(<PricingTable rows={rows} />)

    const com = row('com') as HTMLElement
    expect(com).toHaveAttribute('id', 'tld-com')
    expect(within(com).getByRole('link', { name: /for a \.com domain/ })).toHaveAttribute(
      'href',
      '/search?q=yourbrand.com',
    )
  })

  it('shows forty extensions at a time, and the rest on request', async () => {
    const user = userEvent.setup()
    render(<PricingTable rows={rows} />)

    expect(screen.getByText(`${TOTAL} extensions`)).toBeInTheDocument()
    expect(bodyRows()).toHaveLength(40)
    expect(screen.getByText(`Showing 40 of ${TOTAL}`)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show more extensions' }))

    expect(bodyRows()).toHaveLength(TOTAL)
    expect(screen.queryByRole('button', { name: 'Show more extensions' })).not.toBeInTheDocument()
  })

  it('filters as you type, ignoring case and a leading dot', async () => {
    const user = userEvent.setup()
    render(<PricingTable rows={rows} />)

    await user.type(filter(), '.AFR')

    expect(bodyRows().map((header) => header.textContent)).toEqual(['.africaincl. ICANN fee'])
    expect(screen.getByText(`1 of ${TOTAL} extensions`)).toBeInTheDocument()
  })

  it('starts a new filter from the first page again', async () => {
    const user = userEvent.setup()
    render(<PricingTable rows={rows} />)

    await user.click(screen.getByRole('button', { name: 'Show more extensions' }))
    await user.type(filter(), 'ext')

    expect(bodyRows()).toHaveLength(40)
    expect(screen.getByText(`${FILLER.length} of ${TOTAL} extensions`)).toBeInTheDocument()
    expect(screen.getByText(`Showing 40 of ${FILLER.length}`)).toBeInTheDocument()
  })

  it('says when nothing matches, and suggests a shorter search', async () => {
    const user = userEvent.setup()
    render(<PricingTable rows={rows} />)

    await user.type(filter(), '  zzz ')

    expect(screen.queryAllByRole('rowheader')).toHaveLength(0)
    expect(
      screen.getByText('No extension matches “zzz”. Try a shorter search.'),
    ).toBeInTheDocument()
    expect(screen.getByText(`0 of ${TOTAL} extensions`)).toBeInTheDocument()
  })

  it('marks itself enhanced once hydrated, so a filter typed now is not lost', () => {
    const { container } = render(<PricingTable rows={rows} />)

    expect(container.firstElementChild).toHaveAttribute('data-enhanced', 'true')
  })
})
