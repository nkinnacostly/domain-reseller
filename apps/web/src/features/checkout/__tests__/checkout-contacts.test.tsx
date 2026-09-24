import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOrder } from '../actions/place-order'
import { CheckoutForm } from '../components/checkout-form'

// The server action is the network boundary for this form.
vi.mock('../actions/place-order', () => ({ placeOrder: vi.fn() }))

/** FR-C5, FR-A4 — the other three contacts, as checkout sends them. */

const REGISTRANT = {
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
const PROFILE_ID = '22222222-2222-4222-8222-222222222222'

function renderForm() {
  render(
    <CheckoutForm
      lines={[
        {
          domain: 'getpaid.com',
          years: 1,
          total: '₦18,400',
          renewal: '₦18,700',
          includesIcannFee: true,
        },
      ]}
      summary={{
        subtotal: '₦18,400',
        vatPct: 7.5,
        vat: '₦1,380',
        total: '₦19,780',
        totalKobo: 1_978_000,
      }}
      registrant={REGISTRANT}
      testMode={false}
      profiles={[{ id: PROFILE_ID, label: 'Accounts', name: 'Bola Ade' }]}
    />,
  )
  return screen.getByRole('form', { name: 'Checkout' })
}

async function openContacts(user: ReturnType<typeof userEvent.setup>) {
  const summary = screen.getByText('Different contacts for administrative, technical or billing?')
  await user.click(summary)
  const details = summary.closest('details') as HTMLDetailsElement
  if (!details.open) {
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
  }
}

async function pay(user: ReturnType<typeof userEvent.setup>, form: HTMLElement) {
  await user.click(within(form).getByRole('checkbox', { name: /checked the spelling/ }))
  await user.click(within(form).getByRole('button', { name: /^Pay / }))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('location', { ...window.location, assign: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('CheckoutForm — other contacts', () => {
  it('shows a refused role beside the role, and opens the section to it', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: {
        error: 'Billing contact: That saved contact is no longer on your account.',
        field: 'contacts.billing',
      },
    } as never)
    const form = renderForm()
    await openContacts(user)
    const billing = within(form).getByRole('group', { name: 'Billing contact' })
    await user.click(within(billing).getByRole('radio', { name: 'A saved contact' }))
    await user.selectOptions(within(billing).getByLabelText('Saved contact'), PROFILE_ID)
    await pay(user, form)

    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Billing contact: That saved contact is no longer on your account.',
    )
    expect(billing).toHaveAccessibleDescription(/no longer on your account/)
  })

  it('sends no contacts when every role stays with the registrant', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({ data: { redirectTo: 'https://pay.test' } } as never)
    const form = renderForm()
    await pay(user, form)
    expect(vi.mocked(placeOrder).mock.calls[0]?.[0]).not.toHaveProperty('contacts')
  })

  it('sends each role given to someone else', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({ data: { redirectTo: 'https://pay.test' } } as never)
    const form = renderForm()
    await openContacts(user)
    const billing = within(form).getByRole('group', { name: 'Billing contact' })
    await user.click(within(billing).getByRole('radio', { name: 'New details' }))
    await user.type(within(billing).getByLabelText('First name'), 'Bola')
    const technical = within(form).getByRole('group', { name: 'Technical contact' })
    await user.click(within(technical).getByRole('radio', { name: 'A saved contact' }))
    await user.selectOptions(within(technical).getByLabelText('Saved contact'), PROFILE_ID)
    await pay(user, form)

    expect(vi.mocked(placeOrder).mock.calls[0]?.[0]).toMatchObject({
      registrant: expect.objectContaining({ firstName: 'Ada' }),
      contacts: {
        technical: { kind: 'profile', profileId: PROFILE_ID },
        billing: { kind: 'new', contact: expect.objectContaining({ firstName: 'Bola' }) },
      },
    })
  })
})
