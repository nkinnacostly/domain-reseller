import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BulkRenewalDomain, BulkRenewalOption } from '../components/bulk-renew-form'

// The server action is the network boundary: the form sees only its result.
vi.mock('../actions/place-renewals', () => ({ placeRenewals: vi.fn() }))

const { placeRenewals } = await import('../actions/place-renewals')
const { BulkRenewForm } = await import('../components/bulk-renew-form')

const A = '4f5d3c1a-7b2e-4c8d-9a6f-1e2b3c4d5e6f'
const B = '5a6b7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d'

const DOMAINS: BulkRenewalDomain[] = [
  {
    id: A,
    domainName: 'getpaid.com',
    expires: '24 September 2027',
    renewal: '₦18,700/yr',
    priceRise: null,
  },
  {
    id: B,
    domainName: 'naija.ng',
    expires: '1 March 2027',
    renewal: '₦10,500/yr',
    priceRise: { from: '₦9,500/yr', to: '₦10,500/yr' },
  },
]
const OPTIONS: BulkRenewalOption[] = [
  {
    years: 1,
    subtotal: '₦29,200',
    vat: '₦2,190',
    total: '₦31,390',
    totalKobo: 3_139_000,
    lines: {
      [A]: { newExpiry: '24 September 2028', price: '₦18,700' },
      [B]: { newExpiry: '1 March 2028', price: '₦10,500' },
    },
  },
  {
    years: 2,
    subtotal: '₦58,400',
    vat: '₦4,380',
    total: '₦62,780',
    totalKobo: 6_278_000,
    lines: {
      [A]: { newExpiry: '24 September 2029', price: '₦37,400' },
      [B]: { newExpiry: '1 March 2029', price: '₦21,000' },
    },
  },
]

const renderForm = (testMode = false) =>
  render(<BulkRenewForm domains={DOMAINS} options={OPTIONS} vatPct={7.5} testMode={testMode} />)

beforeEach(() => vi.mocked(placeRenewals).mockReset())

describe('BulkRenewForm (FR-P4, FR-P5, N8)', () => {
  it('shows every domain’s new expiry, its renewal price and its line, then the whole total', async () => {
    const user = userEvent.setup()
    renderForm()
    const list = screen.getByRole('list', { name: 'Domains to renew' })
    const [first, second] = within(list).getAllByRole('listitem')
    expect(first).toHaveTextContent(
      'Expires 24 September 2027 → 24 September 2028 · renews at ₦18,700/yr₦18,700',
    )
    expect(second).toHaveTextContent('renews at ₦10,500/yr')
    expect(screen.getByText('Renewals (2 × 1 year)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay ₦31,390' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Renew each for'), '2')
    expect(first).toHaveTextContent('→ 24 September 2029')
    expect(screen.getByText('Renewals (2 × 2 years)')).toBeInTheDocument()
    expect(screen.getByText('₦4,380')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay ₦62,780' })).toBeInTheDocument()
  })

  it('says a higher renewal price out loud before paying (FR-RN7)', () => {
    renderForm()
    expect(screen.getByText('Some renewal prices have gone up.').parentElement).toHaveTextContent(
      'naija.ng: now ₦10,500/yr, up from ₦9,500/yr',
    )
  })

  it('says a test payment moves no money', () => {
    renderForm(true)
    expect(screen.getByRole('status')).toHaveTextContent('Test mode.')
  })

  it('pays for every domain at the total shown, and goes to Flutterwave', async () => {
    const user = userEvent.setup()
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    vi.mocked(placeRenewals).mockResolvedValue({
      data: { redirectTo: 'https://checkout.test/pay/1' },
    } as never)
    renderForm()
    await user.selectOptions(screen.getByLabelText('Renew each for'), '2')
    await user.click(screen.getByRole('button', { name: 'Pay ₦62,780' }))
    expect(placeRenewals).toHaveBeenCalledWith({
      domainIds: [A, B],
      years: 2,
      expectedTotalKobo: 6_278_000,
    })
    expect(assign).toHaveBeenCalledWith('https://checkout.test/pay/1')
    vi.unstubAllGlobals()
  })

  it('says why nothing was charged', async () => {
    const user = userEvent.setup()
    vi.mocked(placeRenewals).mockResolvedValue({
      data: { error: "naija.ng: Demo domains can’t be renewed. You haven't been charged." },
    } as never)
    renderForm()
    await user.click(screen.getByRole('button', { name: /^Pay / }))
    expect(await screen.findByRole('alert')).toHaveTextContent("You haven't been charged.")

    vi.mocked(placeRenewals).mockResolvedValue({
      serverError: 'Something went wrong on our end. Please try again.',
    } as never)
    await user.click(screen.getByRole('button', { name: /^Pay / }))
    expect(
      await screen.findByText('Something went wrong on our end. Please try again.'),
    ).toBeInTheDocument()
  })

  it('renders nothing without a choice of years', () => {
    const { container } = render(
      <BulkRenewForm domains={DOMAINS} options={[]} vatPct={7.5} testMode={false} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
