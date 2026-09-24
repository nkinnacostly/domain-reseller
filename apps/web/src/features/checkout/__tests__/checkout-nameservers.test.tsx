import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NameserverPreset } from '@/features/domains/queries/domains'
import { placeOrder } from '../actions/place-order'
import { CheckoutForm } from '../components/checkout-form'
import { perZoneExplanation } from '../lib/nameservers'

// The server action is the network boundary for this form.
vi.mock('../actions/place-order', () => ({ placeOrder: vi.fn() }))

const VERCEL: NameserverPreset = {
  id: '0d8f4d8e-5a8b-4c43-9a0f-3a6b1d2e7f10',
  provider: 'Vercel',
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  assignsPerZone: false,
  notes: 'For sites deployed on Vercel.',
  sourceUrl: 'https://vercel.com/docs/domains/working-with-nameservers',
}
const CLOUDFLARE: NameserverPreset = {
  id: '7a1e2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
  provider: 'Cloudflare',
  nameservers: [],
  assignsPerZone: true,
  notes: null,
  sourceUrl: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
}

function renderForm(presets: NameserverPreset[] = [VERCEL, CLOUDFLARE]) {
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
      presets={presets}
    />,
  )
  return screen.getByRole('form', { name: 'Checkout' })
}

const pay = () => screen.getByRole('button', { name: /^Pay ₦19,780$/ })
const section = () =>
  screen.getByText('Already know where this domain is going?').closest('details')

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(placeOrder).mockResolvedValue({ data: { error: 'stop here' } } as never)
  vi.stubGlobal('location', { ...window.location, assign: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('Nameservers at checkout — a choice that cannot work is caught first', () => {
  it('asks for a host when “Pick my host” has none, and sends nothing', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Pick my host' }))

    await user.click(pay())

    const host = screen.getByLabelText('Your host')
    expect(host).toHaveAttribute('aria-invalid', 'true')
    expect(host).toHaveAccessibleDescription('Choose your host, or pick another option.')
    expect(host).toHaveFocus()
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('explains a per-zone host on the spot, and will not send the order with it (FR-D3)', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Pick my host' }))
    await user.selectOptions(screen.getByLabelText('Your host'), 'Cloudflare')

    expect(screen.getByText(perZoneExplanation('Cloudflare'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Cloudflare nameservers' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Cloudflare’s instructions' })).toHaveAttribute(
      'href',
      CLOUDFLARE.sourceUrl,
    )

    await user.click(pay())

    expect(screen.getByLabelText('Your host')).toHaveAccessibleDescription(
      /Choose another option to continue: Cloudflare/,
    )
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('clears the problem once another choice is made', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Pick my host' }))
    await user.click(pay())
    expect(screen.getByLabelText('Your host')).toHaveAttribute('aria-invalid', 'true')

    await user.selectOptions(screen.getByLabelText('Your host'), 'Vercel')

    expect(screen.getByLabelText('Your host')).not.toHaveAttribute('aria-invalid')
  })
})

describe('Nameservers at checkout — what is sent (FR-C10)', () => {
  it('starts collapsed, on the registrar’s default, and sends no nameservers', async () => {
    const user = userEvent.setup()
    renderForm()
    expect(section()).not.toHaveAttribute('open')
    expect(
      screen.getByRole('radio', { name: 'Leave the registrar’s default for now', hidden: true }),
    ).toBeChecked()

    await user.click(pay())

    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ nameservers: '' }))
    expect(vi.mocked(placeOrder).mock.calls[0]?.[0]).not.toHaveProperty('presetId')
  })

  it('shows what a host sets, with its notes and its own instructions (FR-D1)', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Pick my host' }))
    await user.selectOptions(screen.getByLabelText('Your host'), 'Vercel')

    const hosts = screen.getByRole('list', { name: 'Vercel nameservers' })
    expect(
      within(hosts)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['ns1.vercel-dns.com', 'ns2.vercel-dns.com'])
    expect(screen.getByText(/For sites deployed on Vercel\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Vercel’s instructions' })).toHaveAttribute(
      'href',
      VERCEL.sourceUrl,
    )
  })

  it('sends only the host’s id — never nameservers typed before switching (N11)', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Enter nameservers' }))
    await user.type(screen.getByLabelText('Nameservers from your host'), 'ns1.other.com')
    await user.click(screen.getByRole('radio', { name: 'Pick my host' }))
    await user.selectOptions(screen.getByLabelText('Your host'), 'Vercel')

    await user.click(pay())

    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ nameservers: '', presetId: VERCEL.id }),
    )
  })

  it('does not offer “Pick my host” when there are no verified hosts', async () => {
    const user = userEvent.setup()
    renderForm([])
    await user.click(screen.getByText('Already know where this domain is going?'))
    expect(screen.queryByRole('radio', { name: 'Pick my host' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })
})

describe('Nameservers at checkout — the server’s answer', () => {
  it('shows a refused host beside the host, not as a general error', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: { error: 'That host is no longer on our list.', field: 'presetId' },
    } as never)
    const form = renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Pick my host' }))
    await user.selectOptions(screen.getByLabelText('Your host'), 'Vercel')

    await user.click(pay())

    expect(await screen.findByLabelText('Your host')).toHaveAccessibleDescription(
      'That host is no longer on our list.',
    )
    expect(within(form).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens the section and goes to the nameservers the server refused', async () => {
    const user = userEvent.setup()
    vi.mocked(placeOrder).mockResolvedValue({
      data: { error: 'At least two nameservers are required', field: 'nameservers' },
    } as never)
    renderForm()
    await user.click(screen.getByText('Already know where this domain is going?'))
    await user.click(screen.getByRole('radio', { name: 'Enter nameservers' }))
    await user.type(screen.getByLabelText('Nameservers from your host'), 'ns1.host.com')
    section()?.removeAttribute('open')

    await user.click(pay())

    const box = await screen.findByLabelText('Nameservers from your host')
    expect(box).toHaveAccessibleDescription('At least two nameservers are required')
    expect(box).toHaveFocus()
    expect(section()).toHaveAttribute('open')
  })
})
