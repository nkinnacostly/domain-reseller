import {
  formatNaira,
  type PricingInputs,
  priceCatalogue,
  type TldRecord,
  vatKobo,
} from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { createClient } from '@/lib/supabase/server'
import { CartContents, CartSkeleton } from '../components/cart-contents'
import { cartTotals, priceLine, type StoredLine } from '../lib/lines'
import { getCartView } from '../queries/cart'

vi.mock('../queries/cart', () => ({ getCartView: vi.fn() }))
vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('../actions/cart', () => ({
  acceptCurrentPrices: vi.fn(),
  removeCartLine: vi.fn(),
  updateCartLine: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string, maxPeriod = 10): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 11.51,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const tlds = priceCatalogue([record('com', 3)], INPUTS)
const com = tlds[0]
if (!com) throw new Error('fixture')
const catalogue = {
  tlds,
  featured: [],
  effectiveRate: 1334,
  rateSource: 'test',
  rateUpdatedAt: new Date(),
  rateId: 'rate-1',
  vatPct: 7.5,
  version: 'test',
}

const NOW = new Date('2026-09-23T10:10:00.000Z')
const stored = (overrides: Partial<StoredLine> = {}): StoredLine => ({
  id: 'line-1',
  domain: 'getpaid.com',
  tld: 'com',
  periodYears: 1,
  privacy: true,
  autoRenew: true,
  quotedTotalKobo: com.registration.priceKobo,
  quotedRenewalKobo: com.renewal.priceKobo,
  quotedAt: '2026-09-23T10:00:00.000Z',
  ...overrides,
})

/** A ready cart, priced by the real rules — only the reads are faked. */
function readyCart(lines: StoredLine[]) {
  const priced = lines.map((line) => priceLine(line, line.tld === 'com' ? com : undefined, NOW, 30))
  const totals = cartTotals(priced, (amount) => vatKobo(amount, 7.5))
  vi.mocked(getCartView).mockResolvedValue({
    state: 'ready',
    lines: priced,
    totals,
    vatPct: 7.5,
    lockMinutes: 30,
  })
  return totals
}

function signedIn(user: { id: string } | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
  } as never)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getPricedCatalogue).mockResolvedValue(catalogue)
  signedIn(null)
})

describe('CartContents — when there is nothing to buy', () => {
  it('says the cart is empty, points to search, and zeroes the badge', async () => {
    vi.mocked(getCartView).mockResolvedValue({ state: 'empty' })
    render(await CartContents())
    expect(screen.getByRole('heading', { name: 'Your cart is empty' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Search for a domain' })).toHaveAttribute(
      'href',
      '/search',
    )
    expect(document.cookie).toContain('dr_cart_count=0')
  })

  it('withholds the cart rather than show it without prices', async () => {
    vi.mocked(getCartView).mockResolvedValue({ state: 'unpriced' })
    render(await CartContents())
    expect(screen.getByRole('status')).toHaveTextContent('Prices are briefly unavailable')
    expect(screen.queryByRole('link', { name: /check out/i })).not.toBeInTheDocument()
  })
})

describe('CartContents — when a line needs the customer first (FR-C4)', () => {
  it('holds checkout until a changed price is accepted', async () => {
    readyCart([stored({ quotedTotalKobo: 1, quotedAt: '2026-09-23T09:00:00.000Z' })])
    render(await CartContents())

    expect(screen.getByRole('status')).toHaveTextContent(
      'Prices are held for 30 minutes. Some have changed since you added them',
    )
    expect(screen.getByRole('button', { name: 'Accept the new prices' })).toBeInTheDocument()
    const summary = screen.getByRole('complementary', { name: 'Order summary' })
    expect(summary).toHaveTextContent('Accept the new prices, or remove what we no longer sell')
    expect(within(summary).queryByRole('link')).not.toBeInTheDocument()
  })

  it('leaves an extension we stopped selling out of the total, and says so', async () => {
    readyCart([stored(), stored({ id: 'line-2', domain: 'getpaid.gone', tld: 'gone' })])
    render(await CartContents())

    const summary = screen.getByRole('complementary', { name: 'Order summary' })
    expect(summary).toHaveTextContent('Leaves out 1 domain we no longer sell.')
    expect(within(summary).queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept the new prices' })).not.toBeInTheDocument()
  })

  it('counts several extensions we stopped selling in the plural', async () => {
    readyCart([
      stored(),
      stored({ id: 'line-2', domain: 'getpaid.gone', tld: 'gone' }),
      stored({ id: 'line-3', domain: 'getpaid.old', tld: 'old' }),
    ])
    render(await CartContents())
    expect(screen.getByRole('complementary', { name: 'Order summary' })).toHaveTextContent(
      'Leaves out 2 domains we no longer sell.',
    )
  })
})

describe('CartContents — a cart ready to buy', () => {
  it('asks a guest to sign in, and says the cart is kept in this browser', async () => {
    readyCart([stored()])
    render(await CartContents())

    const summary = screen.getByRole('complementary', { name: 'Order summary' })
    expect(within(summary).getByRole('link', { name: 'Sign in to check out' })).toHaveAttribute(
      'href',
      '/sign-in?next=%2Fapp%2Fcheckout',
    )
    expect(summary).toHaveTextContent('Your cart is saved in this browser')
  })

  it('sends a signed-in customer straight to checkout', async () => {
    signedIn({ id: 'user-1' })
    readyCart([stored()])
    render(await CartContents())

    const summary = screen.getByRole('complementary', { name: 'Order summary' })
    expect(within(summary).getByRole('link', { name: 'Continue to checkout' })).toHaveAttribute(
      'href',
      '/app/checkout',
    )
    expect(summary).toHaveTextContent('Your cart is saved to your account.')
  })

  it('itemises the subtotal, VAT and total (FR-C5)', async () => {
    const totals = readyCart([stored(), stored({ id: 'line-2', domain: 'paidly.com' })])
    render(await CartContents())

    const summary = screen.getByRole('complementary', { name: 'Order summary' })
    expect(summary).toHaveTextContent(`2 domains${formatNaira(totals.subtotalKobo)}`)
    expect(summary).toHaveTextContent(`VAT (7.5%)${formatNaira(totals.vatKobo)}`)
    expect(summary).toHaveTextContent(`Total${formatNaira(totals.totalKobo)}`)
  })

  it('lists each domain, and corrects the badge to the real count', async () => {
    readyCart([stored()])
    render(await CartContents())

    const list = screen.getByRole('list', { name: 'Domains in your cart' })
    expect(within(list).getByRole('listitem', { name: 'getpaid.com' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Order summary' })).toHaveTextContent(
      '1 domain',
    )
    expect(document.cookie).toContain('dr_cart_count=1')
  })

  it('offers every period the registry allows', async () => {
    readyCart([stored()])
    render(await CartContents())
    const period = screen.getByLabelText('Registration period')
    expect(
      within(period)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^1 year — ₦/),
      expect.stringMatching(/^2 years — ₦/),
      expect.stringMatching(/^3 years — ₦/),
    ])
  })

  it('still shows the cart if the catalogue drops out between reads, locking the period', async () => {
    readyCart([stored()])
    vi.mocked(getPricedCatalogue).mockResolvedValue(null)
    render(await CartContents())
    const period = screen.getByLabelText('Registration period')
    expect(
      within(period)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['1 year'])
    expect(period).toBeDisabled()
  })
})

describe('CartSkeleton', () => {
  it('is hidden from assistive technology while the cart loads', () => {
    const { container } = render(<CartSkeleton />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})
