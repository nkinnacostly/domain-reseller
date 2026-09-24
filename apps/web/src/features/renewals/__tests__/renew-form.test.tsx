import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { placeRenewal } from '../actions/place-renewal'
import { type RenewalOption, RenewForm } from '../components/renew-form'

// The server action is the network boundary for this form.
vi.mock('../actions/place-renewal', () => ({ placeRenewal: vi.fn() }))

const DOMAIN_ID = '6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10'
const OPTIONS: RenewalOption[] = [
  {
    years: 1,
    newExpiry: '24 September 2028',
    subtotal: '₦18,700',
    vat: '₦1,403',
    total: '₦20,103',
    totalKobo: 2_010_300,
  },
  {
    years: 2,
    newExpiry: '24 September 2029',
    subtotal: '₦37,400',
    vat: '₦2,805',
    total: '₦40,205',
    totalKobo: 4_020_500,
  },
]

function renderForm(
  overrides: Partial<{
    options: RenewalOption[]
    priceRise: { from: string; to: string } | null
    testMode: boolean
  }> = {},
) {
  return render(
    <RenewForm
      domainId={DOMAIN_ID}
      domainName="getpaid.com"
      perYear="₦18,700"
      vatPct={7.5}
      options={overrides.options ?? OPTIONS}
      priceRise={overrides.priceRise ?? null}
      testMode={overrides.testMode ?? false}
    />,
  )
}

const period = () => screen.getByRole('combobox', { name: 'Renew for' })
const payButton = () => screen.getByRole('button', { name: /^Pay ₦|Checking|Taking you/ })

/** The price breakdown, as each term and its amount read together. */
const breakdown = () =>
  screen
    .getAllByRole('term')
    .map((term) => [term.textContent, term.nextElementSibling?.textContent])

function deferred() {
  let resolve: (value: unknown) => void = () => undefined
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const assign = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('location', { ...window.location, assign })
})

afterEach(() => vi.unstubAllGlobals())

describe('RenewForm — choosing how long (FR-RN1)', () => {
  it('starts on the first period offered, with its new expiry and full price', () => {
    renderForm()

    expect(period()).toHaveValue('1')
    expect(period()).toHaveAccessibleDescription('New expiry: 24 September 2028')
    expect(breakdown()).toEqual([
      ['Renewal (1 × ₦18,700)', '₦18,700'],
      ['VAT (7.5%)', '₦1,403'],
      ['Total', '₦20,103'],
    ])
    expect(payButton()).toHaveTextContent('Pay ₦20,103')
  })

  it('lists every period on offer with what it costs before VAT', () => {
    renderForm()
    expect(
      within(period())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['1 year — ₦18,700', '2 years — ₦37,400'])
  })

  it('re-dates and re-prices everything when another period is chosen (FR-C5)', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(period(), '2')

    expect(period()).toHaveValue('2')
    expect(period()).toHaveAccessibleDescription('New expiry: 24 September 2029')
    expect(breakdown()).toEqual([
      ['Renewal (2 × ₦18,700)', '₦37,400'],
      ['VAT (7.5%)', '₦2,805'],
      ['Total', '₦40,205'],
    ])
    expect(payButton()).toHaveTextContent('Pay ₦40,205')
  })

  it('renders nothing when no period can be offered', () => {
    const { container } = renderForm({ options: [] })
    expect(container).toBeEmptyDOMElement()
  })
})

describe('RenewForm — paying', () => {
  it('pays for the first period, at the total shown, when nothing is changed', async () => {
    const user = userEvent.setup()
    vi.mocked(placeRenewal).mockResolvedValue({ data: { error: 'stop here' } } as never)
    renderForm()

    await user.click(payButton())

    expect(placeRenewal).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      years: 1,
      expectedTotalKobo: 2_010_300,
    })
  })

  it('pays for the period chosen, at the total the customer saw (FR-C4)', async () => {
    const user = userEvent.setup()
    vi.mocked(placeRenewal).mockResolvedValue({ data: { error: 'stop here' } } as never)
    renderForm()

    await user.selectOptions(period(), '2')
    await user.click(payButton())

    expect(placeRenewal).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      years: 2,
      expectedTotalKobo: 4_020_500,
    })
  })

  it('shows it is checking, and cannot be pressed twice', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    vi.mocked(placeRenewal).mockReturnValue(pending.promise as never)
    renderForm()

    await user.click(payButton())

    expect(payButton()).toBeDisabled()
    expect(payButton()).toHaveTextContent('Checking everything…')
    expect(period()).toBeDisabled()
    await act(async () => pending.resolve({ data: { error: 'stop here' } }))
    expect(payButton()).toBeEnabled()
  })

  it('hands over to Flutterwave, and keeps the button and the period locked while it does', async () => {
    const user = userEvent.setup()
    vi.mocked(placeRenewal).mockResolvedValue({
      data: { redirectTo: 'https://checkout.flutterwave.test/pay/renew-1' },
    } as never)
    renderForm()

    await user.click(payButton())

    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://checkout.flutterwave.test/pay/renew-1'),
    )
    expect(payButton()).toBeDisabled()
    expect(payButton()).toHaveTextContent('Taking you to Flutterwave…')
    expect(period()).toBeDisabled()
  })
})

describe('RenewForm — when the renewal is refused', () => {
  it('says why it could not be paid for, and lets the customer try again', async () => {
    const user = userEvent.setup()
    vi.mocked(placeRenewal).mockResolvedValue({
      data: {
        error:
          "The renewal price has changed since this page loaded. You haven't been charged. Check the new total, then pay.",
      },
    } as never)
    renderForm()

    await user.click(payButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "The renewal price has changed since this page loaded. You haven't been charged.",
    )
    expect(payButton()).toBeEnabled()
    expect(assign).not.toHaveBeenCalled()
  })

  it('shows a server failure', async () => {
    const user = userEvent.setup()
    vi.mocked(placeRenewal).mockResolvedValue({
      serverError: 'Please sign in to continue.',
    } as never)
    renderForm()

    await user.click(payButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Please sign in to continue.')
    expect(assign).not.toHaveBeenCalled()
  })

  it('shows no error before anything is tried', () => {
    renderForm()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('RenewForm — what the customer is told before paying', () => {
  it('says when payments are in test mode, and that the renewal is a test one', () => {
    renderForm({ testMode: true })
    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('Test mode.')
    expect(note).toHaveTextContent('the renewal is made in the registrar’s test system')
  })

  it('shows no test-mode notice on live payments', () => {
    renderForm()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says the renewal price has gone up, from what and to what, before paying (FR-RN7)', () => {
    renderForm({ priceRise: { from: '₦15,000', to: '₦18,700' } })
    expect(screen.getByText('The renewal price has gone up.').parentElement).toHaveTextContent(
      'The renewal price has gone up. It is now ₦18,700/yr, up from the ₦15,000/yr quoted when you last paid for getpaid.com.',
    )
  })

  it('says nothing about the price when it has not gone up', () => {
    renderForm()
    expect(screen.queryByText('The renewal price has gone up.')).not.toBeInTheDocument()
  })

  it('says Flutterwave adds its own fee on its payment page (FR-C5, N9b)', () => {
    renderForm()
    expect(
      screen.getByText(/Flutterwave adds its own processing fee on its payment page/),
    ).toBeInTheDocument()
  })

  it('links the registration agreement and refund policy (CMP-1, CMP-2)', () => {
    renderForm()
    expect(screen.getByRole('link', { name: 'registration agreement' })).toHaveAttribute(
      'href',
      '/legal/registration-agreement',
    )
    expect(screen.getByRole('link', { name: 'refund policy' })).toHaveAttribute(
      'href',
      '/legal/refunds',
    )
  })
})
