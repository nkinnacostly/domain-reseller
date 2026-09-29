import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { placeTransfer } from '../actions/place-transfer'
import { TransferCheckoutForm } from '../components/transfer-checkout-form'

// The server action is the network boundary for this form.
vi.mock('../actions/place-transfer', () => ({ placeTransfer: vi.fn() }))

const REGISTRANT = {
  firstName: 'Ada',
  lastName: 'Okafor',
  company: '',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  addressLine2: '',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const SUMMARY = {
  transfer: '₦17,000',
  renewal: '₦18,700/yr',
  vatPct: 7.5,
  vat: '₦1,275',
  total: '₦18,275',
  totalKobo: 1_827_500,
  includesIcannFee: true,
}

function renderForm(testMode = false) {
  return render(
    <TransferCheckoutForm
      domain="getpaid.com"
      registrant={REGISTRANT}
      summary={SUMMARY}
      testMode={testMode}
    />,
  )
}

const codeField = () => screen.getByLabelText('Transfer code')
const payButton = () => screen.getByRole('button', { name: /^Pay ₦|Checking|Taking you/ })
const review = () => within(screen.getByRole('complementary', { name: 'Check and pay' }))

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

describe('TransferCheckoutForm — what is being bought (FR-T2, N8)', () => {
  it('shows the domain, the transfer price with its renewal price, VAT and the total', () => {
    renderForm()
    expect(review().getByText('getpaid.com')).toBeInTheDocument()
    expect(review().getByText(/Transfer ₦17,000, then renews at ₦18,700\/yr/)).toHaveTextContent(
      'includes the ICANN fee',
    )
    expect(
      review()
        .getAllByRole('term')
        .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
    ).toEqual([
      ['Transfer', '₦17,000'],
      ['VAT (7.5%)', '₦1,275'],
      ['Total', '₦18,275'],
    ])
    expect(payButton()).toHaveTextContent('Pay ₦18,275')
  })

  it('says Flutterwave adds its own fee on its payment page (FR-C5, N9b)', () => {
    renderForm()
    expect(
      screen.getByText(/Flutterwave adds its own processing fee on its payment page/),
    ).toBeInTheDocument()
  })

  it('says so in test mode, and not otherwise', () => {
    const { unmount } = renderForm(true)
    expect(screen.getByRole('status')).toHaveTextContent(/Test mode\..*registrar’s test system/)
    unmount()
    renderForm(false)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('pre-fills the registrant', () => {
    renderForm()
    expect(screen.getByLabelText('First name')).toHaveValue('Ada')
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com')
    expect(screen.getByLabelText('Country')).toHaveValue('NG')
  })
})

describe('TransferCheckoutForm — the transfer code (N13)', () => {
  it('is masked, and kept from autofill and saved passwords', () => {
    renderForm()
    expect(codeField()).toHaveAttribute('type', 'password')
    expect(codeField()).toHaveAttribute('autocomplete', 'off')
    expect(codeField()).toHaveAttribute('spellcheck', 'false')
  })

  it('can be shown to check it, and hidden again', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(codeField(), 'Ab#12')
    const toggle = screen.getByRole('button', { name: 'Show the transfer code' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(toggle)
    expect(codeField()).toHaveAttribute('type', 'text')
    expect(codeField()).toHaveValue('Ab#12')
    await user.click(screen.getByRole('button', { name: 'Hide the transfer code' }))
    expect(codeField()).toHaveAttribute('type', 'password')
  })
})

describe('TransferCheckoutForm — paying', () => {
  it('sends the code, the registrant and the total the customer saw (FR-C4)', async () => {
    const user = userEvent.setup()
    vi.mocked(placeTransfer).mockResolvedValue({ data: { error: 'stop here' } } as never)
    renderForm()

    await user.type(codeField(), 'Xk9#-code')
    await user.click(payButton())

    expect(placeTransfer).toHaveBeenCalledWith({
      domain: 'getpaid.com',
      authCode: 'Xk9#-code',
      registrant: REGISTRANT,
      expectedTotalKobo: 1_827_500,
    })
  })

  it('shows it is checking the code, and cannot be pressed twice', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    vi.mocked(placeTransfer).mockReturnValue(pending.promise as never)
    renderForm()

    await user.click(payButton())
    expect(payButton()).toBeDisabled()
    expect(payButton()).toHaveTextContent('Checking the code…')
    await act(async () => pending.resolve({ data: { error: 'stop here' } }))
    expect(payButton()).toBeEnabled()
  })

  it('hands over to Flutterwave and stays locked while it does', async () => {
    const user = userEvent.setup()
    vi.mocked(placeTransfer).mockResolvedValue({
      data: { redirectTo: 'https://checkout.flutterwave.test/pay/xfer-1' },
    } as never)
    renderForm()

    await user.click(payButton())
    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://checkout.flutterwave.test/pay/xfer-1'),
    )
    expect(payButton()).toHaveTextContent('Taking you to Flutterwave…')
  })
})

describe('TransferCheckoutForm — when it is refused', () => {
  it('puts a refused code under the code, and points to it', async () => {
    const user = userEvent.setup()
    vi.mocked(placeTransfer).mockResolvedValue({
      data: {
        error: 'Your current registrar didn’t accept that transfer code. You haven’t been charged.',
        field: 'authCode',
      },
    } as never)
    renderForm()

    await user.click(payButton())

    expect(await screen.findByText(/didn’t accept that transfer code/)).toBeInTheDocument()
    expect(codeField()).toHaveAttribute('aria-invalid', 'true')
    expect(codeField()).toHaveAccessibleDescription(/didn’t accept that transfer code/)
    expect(review().getByRole('alert')).toHaveTextContent('The transfer code needs another look')
    expect(assign).not.toHaveBeenCalled()
  })

  it('marks the fields that need fixing', async () => {
    const user = userEvent.setup()
    vi.mocked(placeTransfer).mockResolvedValue({
      validationErrors: {
        authCode: { _errors: ['Enter the transfer code from your current registrar'] },
        registrant: { phone: { _errors: ['Enter a phone number'] } },
      },
    } as never)
    renderForm()

    await user.click(payButton())

    expect(
      await screen.findByText('Enter the transfer code from your current registrar'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Phone')).toHaveAttribute('aria-invalid', 'true')
    expect(review().getByRole('alert')).toHaveTextContent('Some details need fixing')
  })

  it('links to Settings when the account must turn two-factor on first (FR-A2)', async () => {
    const user = userEvent.setup()
    vi.mocked(placeTransfer).mockResolvedValue({
      data: {
        error:
          "Accounts holding more than 10 domains need two-factor authentication before transferring more domains in. You haven't been charged.",
        twoFactor: true,
      },
    } as never)
    renderForm()

    await user.click(payButton())

    const alert = await review().findByRole('alert')
    expect(alert).toHaveTextContent('before transferring more domains in')
    expect(within(alert).getByRole('link', { name: 'Turn on two-factor' })).toHaveAttribute(
      'href',
      '/app/settings#two-factor',
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it('shows any other refusal, and a server failure, in the review', async () => {
    const user = userEvent.setup()
    vi.mocked(placeTransfer).mockResolvedValue({
      data: { error: 'The transfer price has changed since this page loaded.' },
    } as never)
    const { unmount } = renderForm()
    await user.click(payButton())
    expect(await review().findByRole('alert')).toHaveTextContent('The transfer price has changed')
    unmount()

    vi.mocked(placeTransfer).mockResolvedValue({
      serverError: 'Please sign in to continue.',
    } as never)
    renderForm()
    await user.click(payButton())
    expect(await review().findByRole('alert')).toHaveTextContent('Please sign in to continue.')
  })
})
