import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue, type PricedCatalogue } from '@/features/pricing/queries/pricing'
import { TransferResult } from '../components/transfer-result'
import type { RdapLookup } from '../lib/rdap'
import { lookupDomain } from '../queries/rdap-lookup'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../queries/rdap-lookup', () => ({ lookupDomain: vi.fn() }))

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }

const tld = (name: string, transfer: number | null): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: transfer,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})

const tlds = priceCatalogue([tld('com', 10.61), tld('noxfer', null)], INPUTS)
const CATALOGUE: PricedCatalogue = {
  tlds,
  featured: [],
  effectiveRate: 1333.76,
  rateSource: 'test',
  rateUpdatedAt: new Date('2026-09-22T07:00:00Z'),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

const found = (
  overrides: Partial<Extract<RdapLookup, { kind: 'found' }>['record']> = {},
): RdapLookup => ({
  kind: 'found',
  record: {
    statuses: ['active'],
    registeredAt: '2015-03-01T10:00:00.000Z',
    lastTransferredAt: null,
    expiresAt: '2027-03-01T10:00:00.000Z',
    registrar: 'Example Registrar Ltd',
    ...overrides,
  },
})

async function renderFor(domain?: string) {
  const ui = await TransferResult({
    searchParams: Promise.resolve(domain === undefined ? {} : { domain }),
  })
  return render(ui)
}

const heading = () => screen.getByRole('heading', { level: 2 })

describe('TransferResult', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'))
    vi.mocked(getPricedCatalogue).mockResolvedValue(CATALOGUE)
    vi.mocked(lookupDomain).mockResolvedValue(found())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(lookupDomain).mockReset()
  })

  it('renders nothing until a domain is asked about', async () => {
    const { container } = await renderFor()
    expect(container).toBeEmptyDOMElement()
    expect(lookupDomain).not.toHaveBeenCalled()
  })

  it('explains input that is not a domain, without a lookup', async () => {
    await renderFor('getpaid')
    expect(heading()).toHaveTextContent("That doesn't look like a domain")
    expect(screen.getByText(/Include the extension/)).toBeInTheDocument()
    expect(lookupDomain).not.toHaveBeenCalled()
  })

  it('does not ask the registry about an extension we cannot take', async () => {
    await renderFor('getpaid.noxfer')
    expect(heading()).toHaveTextContent("We don't take transfers for .noxfer yet")
    expect(screen.getByRole('link', { name: 'See every extension' })).toHaveAttribute(
      'href',
      '/pricing',
    )
    expect(lookupDomain).not.toHaveBeenCalled()
  })

  it('promises a date when a waiting period is the only thing in the way', async () => {
    vi.mocked(lookupDomain).mockResolvedValue(found({ registeredAt: '2026-09-12T09:00:00.000Z' }))
    await renderFor('getpaid.com')
    expect(heading()).toHaveTextContent('getpaid.com can move from 11 November 2026')
  })

  it('offers registration for a name nobody holds, and shows no transfer price', async () => {
    vi.mocked(lookupDomain).mockResolvedValue({ kind: 'not-found' })
    await renderFor('getpaid.com')
    expect(heading()).toHaveTextContent("getpaid.com isn't registered")
    expect(screen.getByRole('link', { name: 'Search for getpaid.com' })).toHaveAttribute(
      'href',
      '/search?q=getpaid.com',
    )
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  /** PRD N8 — the transfer price never appears without the renewal price. */
  it('shows the transfer price with its renewal price when ready', async () => {
    await renderFor('https://www.GetPaid.com')
    expect(heading()).toHaveTextContent('getpaid.com is ready to transfer')

    const price = within(screen.getByRole('complementary', { name: 'Transfer price for .com' }))
    expect(price.getByText(/^₦[\d,]+$/)).toBeInTheDocument()
    expect(price.getByText(/\/yr$/)).toBeInTheDocument()
    // Honest about what is not built yet (N9b).
    expect(price.getByText("Starting a transfer isn't open yet.")).toBeInTheDocument()
  })

  it('still checks the registry when prices are unavailable, but claims nothing about them', async () => {
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    await renderFor('getpaid.com')
    expect(lookupDomain).toHaveBeenCalledWith('getpaid.com')
    expect(heading()).toHaveTextContent("We couldn't check everything for getpaid.com")
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })
})
