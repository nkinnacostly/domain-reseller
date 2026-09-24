import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NameserverPreset } from '@/features/domains/queries/domains'
import { placeOrder } from '../actions/place-order'
import { CheckoutForm, type CheckoutLine } from '../components/checkout-form'
import { perZoneExplanation } from '../lib/nameservers'

// The server action is the network boundary for this form.
vi.mock('../actions/place-order', () => ({ placeOrder: vi.fn() }))

const VERCEL: NameserverPreset = {
  id: '0d8f4d8e-5a8b-4c43-9a0f-3a6b1d2e7f10',
  provider: 'Vercel',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  assignsPerZone: false,
  notes: null,
  sourceUrl: 'https://vercel.com/docs/domains/working-with-nameservers',
}
const HOSTINGER: NameserverPreset = {
  id: 'd97320b5-50a9-44d4-a881-7b4bc1a5e077',
  provider: 'Hostinger',
  nameservers: ['ns1.dns-parking.com', 'ns2.dns-parking.com'],
  assignsPerZone: false,
  notes: null,
  sourceUrl: 'https://support.hostinger.com/',
}
const CLOUDFLARE: NameserverPreset = {
  id: '7a1e2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
  provider: 'Cloudflare',
  nameservers: [],
  assignsPerZone: true,
  notes: null,
  sourceUrl: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
}

const line = (domain: string): CheckoutLine => ({
  domain,
  years: 1,
  total: '₦18,400',
  renewal: '₦18,700',
  includesIcannFee: true,
})

function renderForm(domains = ['getpaid.com', 'paidly.com']) {
  render(
    <CheckoutForm
      lines={domains.map(line)}
      summary={{
        subtotal: '₦36,800',
        vatPct: 7.5,
        vat: '₦2,760',
        total: '₦39,560',
        totalKobo: 3_956_000,
      }}
      registrant={{
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
      }}
      testMode={false}
      presets={[CLOUDFLARE, HOSTINGER, VERCEL]}
    />,
  )
  return screen.getByRole('form', { name: 'Checkout' })
}

const pay = () => screen.getByRole('button', { name: /^Pay ₦39,560$/ })
const perDomain = () =>
  screen.getByText('Use a different host for a domain').closest('details') as HTMLElement
const lastCall = () => vi.mocked(placeOrder).mock.calls.at(-1)?.[0]

async function openPerDomain(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Already know where this domain is going?'))
  await user.click(screen.getByText('Use a different host for a domain'))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(placeOrder).mockResolvedValue({ data: { error: 'stop here' } } as never)
  vi.stubGlobal('location', { ...window.location, assign: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('A host per domain — a choice that cannot work is caught first (FR-C10)', () => {
  it('asks for a host for the domain set to “Pick my host”, and sends nothing', async () => {
    const user = userEvent.setup()
    renderForm()
    await openPerDomain(user)
    await user.selectOptions(screen.getByLabelText('paidly.com'), 'Pick my host')

    await user.click(pay())

    const host = screen.getByLabelText('Host for paidly.com')
    expect(host).toHaveAttribute('aria-invalid', 'true')
    expect(host).toHaveAccessibleDescription('Choose your host, or pick another option.')
    expect(host).toHaveFocus()
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('explains a per-zone host for one domain, and will not send it (FR-D3)', async () => {
    const user = userEvent.setup()
    renderForm()
    await openPerDomain(user)
    await user.selectOptions(screen.getByLabelText('getpaid.com'), 'Pick my host')
    await user.selectOptions(screen.getByLabelText('Host for getpaid.com'), 'Cloudflare')
    expect(within(perDomain()).getByText(perZoneExplanation('Cloudflare'))).toBeInTheDocument()

    await user.click(pay())

    expect(screen.getByLabelText('Host for getpaid.com')).toHaveAccessibleDescription(
      /^Choose another option to continue: Cloudflare/,
    )
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('asks for nameservers when a domain’s box is left empty, and clears once changed', async () => {
    const user = userEvent.setup()
    renderForm()
    await openPerDomain(user)
    await user.selectOptions(screen.getByLabelText('paidly.com'), 'Enter nameservers')

    await user.click(pay())

    const box = screen.getByLabelText('Nameservers for paidly.com')
    expect(box).toHaveAccessibleDescription(
      'Enter the nameservers your host gave you, or choose another option.',
    )
    expect(box).toHaveFocus()

    await user.selectOptions(screen.getByLabelText('paidly.com'), 'Same as the rest')
    expect(box).not.toHaveAttribute('aria-invalid')
  })
})

describe('A host per domain — what is sent', () => {
  it('stays folded, and sends every domain on the order’s choice, until one is changed', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(perDomain()).not.toHaveAttribute('open')

    await user.click(pay())

    expect(lastCall()).toMatchObject({ nameservers: '' })
    expect(lastCall()).not.toHaveProperty('lineHosts')
  })

  it('sends a domain’s own host by its id, beside the order’s typed nameservers (N11)', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Enter nameservers' }))
    await user.type(
      screen.getByLabelText('Nameservers from your host'),
      'ns1.host.com{enter}ns2.host.com',
    )
    await user.click(screen.getByText('Use a different host for a domain'))
    await user.selectOptions(screen.getByLabelText('paidly.com'), 'Pick my host')
    await user.selectOptions(screen.getByLabelText('Host for paidly.com'), 'Hostinger')
    expect(
      within(perDomain()).getByRole('list', { name: 'Hostinger nameservers' }),
    ).toHaveTextContent('ns1.dns-parking.com')

    await user.click(pay())

    expect(lastCall()).toMatchObject({
      nameservers: 'ns1.host.com\nns2.host.com',
      lineHosts: [
        { domain: 'paidly.com', mode: 'preset', presetId: HOSTINGER.id, nameservers: '' },
      ],
    })
  })

  it('offers only the ways that exist: no “Pick my host” without verified hosts', async () => {
    const user = userEvent.setup()
    render(
      <CheckoutForm
        lines={[line('getpaid.com'), line('paidly.com')]}
        summary={{ subtotal: '₦1', vatPct: 7.5, vat: '₦1', total: '₦2', totalKobo: 200 }}
        registrant={{
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
        }}
        testMode={false}
      />,
    )
    await openPerDomain(user)
    const options = within(screen.getByLabelText('getpaid.com'))
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).toEqual([
      'Same as the rest',
      'Leave the registrar’s default for now',
      'Enter nameservers',
    ])
  })

  it('is not offered for a single domain — nothing to mix', async () => {
    const user = userEvent.setup()
    renderForm(['getpaid.com'])
    await user.click(screen.getByText('Already know where this domain is going?'))
    expect(screen.queryByText('Use a different host for a domain')).not.toBeInTheDocument()
    expect(screen.getByText(/^One choice for every domain in this order\./)).toBeInTheDocument()
  })
})

describe('A host per domain — the server’s answer', () => {
  it('opens both sections and shows a domain’s refused nameservers beside it, with the details', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: {
        error: 'Some nameservers need fixing before we can use them.',
        field: 'lineHosts',
        domain: 'paidly.com',
        details: ["ns2.hots.com doesn't exist — check the spelling."],
      },
    } as never)
    const form = renderForm()
    await openPerDomain(user)
    await user.selectOptions(screen.getByLabelText('paidly.com'), 'Enter nameservers')
    await user.type(
      screen.getByLabelText('Nameservers for paidly.com'),
      'ns1.host.com ns2.hots.com',
    )
    perDomain().removeAttribute('open')
    screen
      .getByText('Already know where this domain is going?')
      .closest('details')
      ?.removeAttribute('open')

    await user.click(pay())

    const box = await screen.findByLabelText('Nameservers for paidly.com')
    expect(box).toHaveAccessibleDescription(
      "Some nameservers need fixing before we can use them. ns2.hots.com doesn't exist — check the spelling.",
    )
    expect(box).toHaveFocus()
    expect(perDomain()).toHaveAttribute('open')
    // Said beside the field, not again as a general error.
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so above the domains when the problem is with them all', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: { error: 'Your cart changed while you were choosing hosts.', field: 'lineHosts' },
    } as never)
    renderForm()
    await openPerDomain(user)
    await user.selectOptions(
      screen.getByLabelText('paidly.com'),
      'Leave the registrar’s default for now',
    )

    await user.click(pay())

    expect(await within(perDomain()).findByRole('alert')).toHaveTextContent(
      'Your cart changed while you were choosing hosts.',
    )
  })

  it('shows the order’s own refused nameservers with the details, beside its box', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: {
        error: 'Some nameservers need fixing before we can use them.',
        field: 'nameservers',
        details: ["ns2.host.cmo doesn't exist — check the spelling."],
      },
    } as never)
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Enter nameservers' }))
    await user.type(
      screen.getByLabelText('Nameservers from your host'),
      'ns1.host.com ns2.host.cmo',
    )

    await user.click(pay())

    const box = await screen.findByLabelText('Nameservers from your host')
    expect(box).toHaveAccessibleDescription(/ns2\.host\.cmo doesn't exist — check the spelling\.$/)
    expect(box).toHaveFocus()
  })
})

describe('A host per domain — warnings are shown, and do not block (FR-D4)', () => {
  const WARNING =
    "ns2.host.com didn't answer just now. It may be busy; double-check it with your host."

  it('shows the warning before paying, then pays with the same choice', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValueOnce({ data: { warnings: [WARNING] } } as never)
    vi.mocked(placeOrder).mockResolvedValueOnce({
      data: { redirectTo: 'https://checkout.test/pay/1' },
    } as never)
    renderForm()

    await user.click(pay())

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(WARNING)
    expect(notice).toHaveTextContent('Nothing has been charged.')
    expect(lastCall()).not.toHaveProperty('hostWarningsSeen')
    expect(window.location.assign).not.toHaveBeenCalled()

    await user.click(pay())

    expect(lastCall()).toMatchObject({ hostWarningsSeen: true })
    expect(window.location.assign).toHaveBeenCalledWith('https://checkout.test/pay/1')
  })

  it('checks afresh once a choice changes after a warning', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValueOnce({ data: { warnings: [WARNING] } } as never)
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Enter nameservers' }))
    await user.type(
      screen.getByLabelText('Nameservers from your host'),
      'ns1.host.com ns2.host.com',
    )
    await user.click(pay())
    expect(await screen.findByRole('status')).toHaveTextContent(WARNING)

    await user.type(screen.getByLabelText('Nameservers from your host'), 'x')

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await user.click(pay())
    expect(lastCall()).not.toHaveProperty('hostWarningsSeen')
  })
})
