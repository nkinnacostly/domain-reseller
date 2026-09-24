import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removeCartLine, updateCartLine } from '../actions/cart'
import { CartLine } from '../components/cart-line'
import { CartLink } from '../components/cart-link'
import type { LineView } from '../lib/view'

// The server actions are the network boundary for this component.
vi.mock('../actions/cart', () => ({ updateCartLine: vi.fn(), removeCartLine: vi.fn() }))
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const LINE_ID = '00000000-0000-4000-8000-000000000001'

const line = (overrides: Partial<LineView> = {}): LineView => ({
  id: LINE_ID,
  domain: 'getpaid.com',
  tld: 'com',
  status: 'held',
  periodYears: 1,
  total: '₦18,400',
  renewal: '₦18,700',
  was: null,
  heldUntil: '11:30 am',
  includesIcannFee: true,
  privacyOffered: true,
  privacy: true,
  autoRenew: true,
  periodOptions: [
    { years: 1, label: '1 year — ₦18,400' },
    { years: 2, label: '2 years — ₦37,100' },
  ],
  ...overrides,
})

function renderLine(overrides: Partial<LineView> = {}) {
  render(
    <ul>
      <CartLine line={line(overrides)} />
    </ul>,
  )
  return screen.getByRole('listitem', { name: overrides.domain ?? 'getpaid.com' })
}

function deferred() {
  let resolve: (value: unknown) => void = () => undefined
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  // biome-ignore lint/suspicious/noDocumentCookie: the header badge reads this; start it empty
  document.cookie = 'dr_cart_count=; path=/; max-age=0'
})

describe('CartLine — when a change is refused', () => {
  it('says why a change could not be saved', async () => {
    const user = userEvent.setup()
    vi.mocked(updateCartLine).mockResolvedValue({
      data: { error: 'That domain is no longer in your cart.' },
    } as never)
    const item = renderLine()

    await user.selectOptions(within(item).getByLabelText('Registration period'), '2')

    expect(await within(item).findByRole('alert')).toHaveTextContent(
      'That domain is no longer in your cart.',
    )
  })

  it('says why the domain could not be removed', async () => {
    const user = userEvent.setup()
    vi.mocked(removeCartLine).mockResolvedValue({
      data: { error: 'Something went wrong updating your cart. Please try again.' },
    } as never)
    const item = renderLine()

    await user.click(within(item).getByRole('button', { name: 'Remove getpaid.com' }))

    expect(await within(item).findByRole('alert')).toHaveTextContent(
      'Something went wrong updating your cart. Please try again.',
    )
  })

  it('locks every control while a change is saving, so it is not sent twice', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    vi.mocked(updateCartLine).mockReturnValue(pending.promise as never)
    const item = renderLine()

    await user.click(within(item).getByRole('switch', { name: 'Renew automatically' }))

    expect(item).toHaveAttribute('aria-busy', 'true')
    expect(within(item).getByLabelText('Registration period')).toBeDisabled()
    expect(within(item).getByRole('switch', { name: 'Renew automatically' })).toBeDisabled()
    expect(within(item).getByRole('switch', { name: 'Contact privacy' })).toBeDisabled()
    expect(within(item).getByRole('button', { name: 'Remove getpaid.com' })).toBeDisabled()

    await act(async () => pending.resolve({ data: { ok: true } }))
    expect(item).not.toHaveAttribute('aria-busy')
  })
})

describe('CartLine — changing a line', () => {
  it('re-prices a new period and reloads the cart to show it', async () => {
    const user = userEvent.setup()
    vi.mocked(updateCartLine).mockResolvedValue({ data: { ok: true } } as never)
    const item = renderLine()

    await user.selectOptions(within(item).getByLabelText('Registration period'), '2')

    expect(updateCartLine).toHaveBeenCalledWith({ lineId: LINE_ID, periodYears: 2 })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('turns automatic renewal off', async () => {
    const user = userEvent.setup()
    vi.mocked(updateCartLine).mockResolvedValue({ data: { ok: true } } as never)
    const item = renderLine()

    const renew = within(item).getByRole('switch', { name: 'Renew automatically' })
    expect(renew).toBeChecked()
    expect(renew).toHaveAccessibleDescription(
      /At ₦18,700\/yr\. Automatic renewal isn’t switched on yet/,
    )
    await user.click(renew)

    expect(updateCartLine).toHaveBeenCalledWith({ lineId: LINE_ID, autoRenew: false })
  })

  it('turns free contact privacy off', async () => {
    const user = userEvent.setup()
    vi.mocked(updateCartLine).mockResolvedValue({ data: { ok: true } } as never)
    const item = renderLine({ privacy: true })

    const privacy = within(item).getByRole('switch', { name: 'Contact privacy' })
    expect(privacy).toHaveAccessibleDescription(/Free\./)
    await user.click(privacy)

    expect(updateCartLine).toHaveBeenCalledWith({ lineId: LINE_ID, privacy: false })
  })

  it('removes the line, updates the header badge and reloads the cart', async () => {
    const user = userEvent.setup()
    vi.mocked(removeCartLine).mockResolvedValue({ data: { count: 2 } } as never)
    render(
      <>
        <CartLink />
        <ul>
          <CartLine line={line()} />
        </ul>
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Remove getpaid.com' }))

    expect(removeCartLine).toHaveBeenCalledWith({ lineId: LINE_ID })
    expect(await screen.findByRole('link', { name: 'Cart, 2 domains' })).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reloads after a removal even when no count comes back', async () => {
    const user = userEvent.setup()
    vi.mocked(removeCartLine).mockResolvedValue({ data: undefined } as never)
    const item = renderLine()

    await user.click(within(item).getByRole('button', { name: 'Remove getpaid.com' }))

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })
})

describe('CartLine — what it shows', () => {
  it('shows the price with its renewal price, and the ICANN fee inside it (N8, FR-C5)', () => {
    const item = renderLine()
    expect(within(item).getByRole('heading', { name: 'getpaid.com' })).toBeInTheDocument()
    expect(item).toHaveTextContent('₦18,400')
    expect(item).toHaveTextContent('for 1 year, then ₦18,700/yr')
    expect(item).toHaveTextContent('Includes the ICANN fee')
  })

  it('says how long the quoted price is held', () => {
    expect(renderLine()).toHaveTextContent('Price held until 11:30 am')
  })

  it('shows the old and new price when it changed', () => {
    const item = renderLine({ status: 'changed', was: '₦17,900', heldUntil: null })
    expect(item).toHaveTextContent('Price changed: was ₦17,900, now ₦18,400')
    expect(item).not.toHaveTextContent('Price held')
  })

  it('offers no privacy switch, and no ICANN fee, on a country-code extension', () => {
    const item = renderLine({
      domain: 'getpaid.co',
      tld: 'co',
      privacyOffered: false,
      includesIcannFee: false,
      periodYears: 2,
      status: 'current',
      heldUntil: null,
    })
    expect(within(item).queryByRole('switch', { name: 'Contact privacy' })).not.toBeInTheDocument()
    expect(item).not.toHaveTextContent('ICANN')
    expect(item).toHaveTextContent('for 2 years, then')
  })

  it('does not offer a choice of period when there is only one', () => {
    const item = renderLine({ periodOptions: [{ years: 1, label: '1 year — ₦18,400' }] })
    expect(within(item).getByLabelText('Registration period')).toBeDisabled()
  })

  it('offers only removal for an extension we no longer sell', () => {
    const item = renderLine({ status: 'unavailable', tld: 'gone', domain: 'getpaid.gone' })
    expect(item).toHaveTextContent('We no longer sell .gone. Remove it to continue.')
    expect(within(item).queryByLabelText('Registration period')).not.toBeInTheDocument()
    expect(within(item).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(item).getByRole('button', { name: 'Remove getpaid.gone' })).toBeEnabled()
  })
})
