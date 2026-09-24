import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOrder } from '../actions/place-order'
import { CheckoutForm, type CheckoutLine } from '../components/checkout-form'
import type { RegistrantForm } from '../lib/contact'
import { NIGERIAN_STATES, REGISTRANT_COUNTRIES } from '../lib/countries'

// The server action is the network boundary for this form.
vi.mock('../actions/place-order', () => ({ placeOrder: vi.fn() }))

const LINES: CheckoutLine[] = [
  {
    domain: 'getpaid.com',
    years: 1,
    total: '₦18,400',
    renewal: '₦18,700',
    includesIcannFee: true,
  },
  {
    domain: 'getpaid.co',
    years: 2,
    total: '₦74,500',
    renewal: '₦56,100',
    includesIcannFee: false,
  },
]
const SUMMARY = {
  subtotal: '₦92,900',
  vatPct: 7.5,
  vat: '₦6,968',
  total: '₦99,868',
  totalKobo: 9_986_800,
}
const REGISTRANT: RegistrantForm = {
  firstName: 'Ada',
  lastName: 'Okafor',
  company: '',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '0803 123 4567',
  addressLine1: '12 Admiralty Way',
  addressLine2: '',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

function renderForm(overrides: { registrant?: Partial<RegistrantForm>; testMode?: boolean } = {}) {
  render(
    <CheckoutForm
      lines={LINES}
      summary={SUMMARY}
      registrant={{ ...REGISTRANT, ...overrides.registrant }}
      testMode={overrides.testMode ?? false}
    />,
  )
  return screen.getByRole('form', { name: 'Checkout' })
}

const payButton = () => screen.getByRole('button', { name: /^Pay ₦99,868$|Checking|Taking you/ })

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

describe('CheckoutForm — when the order is refused', () => {
  it('marks each field that needs fixing, beside the field', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      validationErrors: {
        registrant: {
          firstName: { _errors: ['Enter a first name'] },
          zipCode: { _errors: ['Enter a postcode'] },
        },
      },
    } as never)
    const form = renderForm({ registrant: { firstName: '' } })

    await user.click(payButton())

    const firstName = await screen.findByLabelText('First name')
    expect(firstName).toHaveAttribute('aria-invalid', 'true')
    expect(firstName).toHaveAccessibleDescription('Enter a first name')
    expect(screen.getByLabelText('Postcode')).toHaveAccessibleDescription('Enter a postcode')
    expect(within(form).getByRole('alert')).toHaveTextContent(
      "Some details need fixing — they're marked above.",
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it('asks for the spelling to be confirmed before anything is charged (FR-C6)', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      validationErrors: { confirmed: { _errors: ['Tick the box to confirm the spelling'] } },
    } as never)
    renderForm()

    await user.click(payButton())

    const confirm = await screen.findByRole('checkbox', { name: /checked the spelling/ })
    expect(confirm).toHaveAttribute('aria-invalid', 'true')
    expect(confirm).toHaveAccessibleDescription('Tick the box to confirm the spelling')
  })

  it('shows a nameserver problem beside the nameservers, not as a general error', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: { error: 'Add at least two nameservers.', field: 'nameservers' },
    } as never)
    const form = renderForm()

    await user.click(payButton())

    expect(await within(form).findByText('Add at least two nameservers.')).toBeInTheDocument()
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says why the order could not be placed, and that nothing was charged', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: { error: "Checkout isn't open yet. You haven't been charged." },
    } as never)
    const form = renderForm()

    await user.click(payButton())

    expect(await within(form).findByRole('alert')).toHaveTextContent(
      "Checkout isn't open yet. You haven't been charged.",
    )
    expect(payButton()).toBeEnabled()
    expect(assign).not.toHaveBeenCalled()
  })

  it('links to Settings when the account must turn two-factor on first (FR-A2)', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: {
        error:
          "Accounts holding more than 10 domains need two-factor authentication before ordering more domains. You haven't been charged.",
        twoFactor: true,
      },
    } as never)
    const form = renderForm()

    await user.click(payButton())

    const alert = await within(form).findByRole('alert')
    expect(alert).toHaveTextContent('need two-factor authentication before ordering more domains')
    expect(within(alert).getByRole('link', { name: 'Turn on two-factor' })).toHaveAttribute(
      'href',
      '/app/settings#two-factor',
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it('offers no two-factor link for any other refusal', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: { error: "Checkout isn't open yet. You haven't been charged." },
    } as never)
    const form = renderForm()
    await user.click(payButton())
    await within(form).findByRole('alert')
    expect(within(form).queryByRole('link', { name: 'Turn on two-factor' })).not.toBeInTheDocument()
  })

  it('shows a server failure', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      serverError: 'Please sign in to continue.',
    } as never)
    const form = renderForm()

    await user.click(payButton())

    expect(await within(form).findByRole('alert')).toHaveTextContent('Please sign in to continue.')
  })
})

describe('CheckoutForm — placing the order', () => {
  it('sends what was typed, the confirmation and the total the customer saw', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({ data: { error: 'stop here' } } as never)
    renderForm({ registrant: { company: '', addressLine2: '' } })

    await user.type(screen.getByLabelText('Company (optional)'), 'Paidly Ltd')
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Enter nameservers' }))
    await user.type(
      screen.getByLabelText('Nameservers from your host'),
      'ns1.host.com{Enter}ns2.host.com',
    )
    await user.click(screen.getByRole('checkbox', { name: /checked the spelling/ }))
    await user.click(payButton())

    expect(placeOrder).toHaveBeenCalledWith({
      registrant: { ...REGISTRANT, company: 'Paidly Ltd' },
      nameservers: 'ns1.host.com\nns2.host.com',
      confirmed: true,
      expectedTotalKobo: 9_986_800,
    })
  })

  it('sends an unticked confirmation as not confirmed, for the server to refuse', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({ data: { error: 'stop here' } } as never)
    renderForm()

    await user.click(payButton())

    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ confirmed: false }))
  })

  it('shows it is checking, and cannot be pressed twice', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    vi.mocked(placeOrder).mockReturnValue(pending.promise as never)
    renderForm()

    await user.click(payButton())

    expect(payButton()).toBeDisabled()
    expect(payButton()).toHaveTextContent('Checking everything…')
    await act(async () => pending.resolve({ data: { error: 'stop here' } }))
    expect(payButton()).toBeEnabled()
  })

  it('hands over to Flutterwave, and keeps the button locked while it does', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: { redirectTo: 'https://checkout.flutterwave.test/pay/1' },
    } as never)
    renderForm()

    await user.click(payButton())

    await vi.waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://checkout.flutterwave.test/pay/1'),
    )
    expect(payButton()).toBeDisabled()
    expect(payButton()).toHaveTextContent('Taking you to Flutterwave…')
  })
})

describe('CheckoutForm — what the customer checks before paying', () => {
  it('pre-fills the registrant', () => {
    renderForm()
    expect(screen.getByLabelText('First name')).toHaveValue('Ada')
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com')
    expect(screen.getByLabelText('Country')).toHaveValue('NG')
  })

  it('shows every name in large type with its period, price and renewal (FR-C6, N8)', () => {
    renderForm()
    const items = within(screen.getByRole('list', { name: 'Domains you are buying' })).getAllByRole(
      'listitem',
    )
    expect(items.map((item) => item.textContent)).toEqual([
      'getpaid.com1 year · ₦18,400, then ₦18,700/yr · includes the ICANN fee',
      'getpaid.co2 years · ₦74,500, then ₦56,100/yr',
    ])
  })

  it('itemises the subtotal, VAT and total, and pays exactly that total (FR-C5)', () => {
    renderForm()
    const review = screen.getByRole('complementary', { name: 'Check and pay' })
    expect(review).toHaveTextContent('Domains₦92,900')
    expect(review).toHaveTextContent('VAT (7.5%)₦6,968')
    expect(review).toHaveTextContent('Total₦99,868')
    expect(screen.getByRole('button', { name: 'Pay ₦99,868' })).toBeEnabled()
  })

  it('says when payments are in test mode, and only then', () => {
    renderForm({ testMode: true })
    expect(screen.getByRole('status')).toHaveTextContent('Test mode.')
  })

  it('shows no test-mode notice on live payments', () => {
    renderForm()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says Flutterwave adds its own fee on its payment page (FR-C5, N9b)', () => {
    renderForm()
    expect(
      screen.getByText(/Flutterwave adds its own processing fee on its payment page/),
    ).toBeInTheDocument()
  })

  it('links the registration agreement, refund policy and registrant rights (CMP-1, CMP-2)', () => {
    renderForm()
    expect(screen.getByRole('link', { name: 'registration agreement' })).toHaveAttribute(
      'href',
      '/legal/registration-agreement',
    )
    expect(screen.getByRole('link', { name: 'refund policy' })).toHaveAttribute(
      'href',
      '/legal/refunds',
    )
    expect(
      screen.getByRole('link', { name: "Registrants' Benefits and Responsibilities" }),
    ).toHaveAttribute('href', '/legal/registrant-rights')
  })
})

describe('CheckoutForm — the registrant’s country', () => {
  it('lists every country by name, Nigeria first, then A to Z', () => {
    renderForm()
    const options = within(screen.getByLabelText('Country')).getAllByRole('option')
    expect(options).toHaveLength(REGISTRANT_COUNTRIES.length)
    expect(options).toHaveLength(249)
    expect(options[0]).toHaveTextContent('Nigeria')
    expect(options[1]).toHaveTextContent('Afghanistan')
    expect(options.at(-1)).toHaveTextContent('Zimbabwe')
    expect(options.map((option) => option.getAttribute('value'))).toEqual(
      expect.arrayContaining(['GB', 'JP', 'BR', 'NZ']),
    )
  })

  it('starts on a saved registrant’s country from anywhere in the world', () => {
    renderForm({ registrant: { country: 'JP' } })
    expect(screen.getByLabelText('Country')).toHaveDisplayValue('Japan')
  })

  it('suggests the 36 states and the FCT, and explains postcodes, for Nigeria', () => {
    renderForm()
    expect(NIGERIAN_STATES).toHaveLength(37)
    const state = screen.getByLabelText('State')
    const list = document.getElementById(state.getAttribute('list') ?? '')
    expect(list?.querySelectorAll('option')).toHaveLength(37)
    expect(screen.getByLabelText('Postcode')).toHaveAccessibleDescription(
      'Nigerian postcodes are 6 digits — 100001 is central Lagos.',
    )
  })

  it('drops the Nigerian suggestions once another country is chosen', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(screen.getByLabelText('Country'), 'GH')

    expect(screen.getByLabelText('Country')).toHaveValue('GH')
    expect(screen.getByLabelText('State')).not.toHaveAttribute('list')
    expect(screen.getByLabelText('Postcode')).not.toHaveAccessibleDescription()
  })

  it('starts in Nigeria when no country is known', () => {
    renderForm({ registrant: { country: undefined } })
    expect(screen.getByLabelText('Country')).toHaveValue('NG')
  })
})
