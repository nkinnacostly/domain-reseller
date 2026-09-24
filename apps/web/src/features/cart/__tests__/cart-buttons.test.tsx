import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptCurrentPrices, addToCart } from '../actions/cart'
import { AcceptPricesButton } from '../components/accept-prices-button'
import { AddToCartButton } from '../components/add-to-cart-button'
import { CartLink } from '../components/cart-link'

// The server actions are the network boundary for these components.
vi.mock('../actions/cart', () => ({ addToCart: vi.fn(), acceptCurrentPrices: vi.fn() }))
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

/** A promise the test settles, to see the in-between state. */
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

describe('AddToCartButton — when the add is refused', () => {
  it('says the name was taken since the search, and stays an add button', async () => {
    const user = userEvent.setup()
    vi.mocked(addToCart).mockResolvedValue({
      data: { error: 'getpaid.com was taken while you were looking.' },
    } as never)
    render(<AddToCartButton domain="getpaid.com" />)

    await user.click(screen.getByRole('button', { name: 'Add getpaid.com to cart' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'getpaid.com was taken while you were looking.',
    )
    expect(screen.getByRole('button', { name: 'Add getpaid.com to cart' })).toBeEnabled()
    expect(screen.queryByRole('link', { name: /in your cart/i })).not.toBeInTheDocument()
  })

  it('shows a server failure the same way', async () => {
    const user = userEvent.setup()
    vi.mocked(addToCart).mockResolvedValue({
      serverError: 'Something went wrong on our end. Please try again.',
    } as never)
    render(<AddToCartButton domain="getpaid.com" size="large" />)

    await user.click(screen.getByRole('button', { name: 'Add getpaid.com to cart' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on our end. Please try again.',
    )
  })
})

describe('AddToCartButton — adding', () => {
  it('shows it is working, and cannot be pressed twice', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    vi.mocked(addToCart).mockReturnValue(pending.promise as never)
    render(<AddToCartButton domain="getpaid.com" />)

    await user.click(screen.getByRole('button', { name: 'Add getpaid.com to cart' }))

    const button = screen.getByRole('button', { name: 'Add getpaid.com to cart' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('Adding…')

    await act(async () => pending.resolve({ data: { count: 1 } }))
    expect(screen.getByRole('link', { name: /in your cart/i })).toBeInTheDocument()
  })

  it('adds exactly that domain, then becomes a link to the cart', async () => {
    const user = userEvent.setup()
    vi.mocked(addToCart).mockResolvedValue({ data: { count: 1 } } as never)
    render(<AddToCartButton domain="getpaid.com" />)

    await user.click(screen.getByRole('button', { name: 'Add getpaid.com to cart' }))

    expect(addToCart).toHaveBeenCalledWith({ domain: 'getpaid.com' })
    const link = await screen.findByRole('link', { name: 'In your cart — view' })
    expect(link).toHaveAttribute('href', '/cart')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('updates the header badge with the new count', async () => {
    const user = userEvent.setup()
    vi.mocked(addToCart).mockResolvedValue({ data: { count: 3 } } as never)
    render(
      <>
        <CartLink />
        <AddToCartButton domain="getpaid.com" />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Add getpaid.com to cart' }))

    expect(await screen.findByRole('link', { name: 'Cart, 3 domains' })).toBeInTheDocument()
  })
})

describe('AcceptPricesButton (FR-C4)', () => {
  it('does not reload the cart when the server fails', async () => {
    const user = userEvent.setup()
    vi.mocked(acceptCurrentPrices).mockResolvedValue({
      serverError: 'Something went wrong on our end. Please try again.',
    } as never)
    render(<AcceptPricesButton />)

    await user.click(screen.getByRole('button', { name: 'Accept the new prices' }))

    await vi.waitFor(() => expect(acceptCurrentPrices).toHaveBeenCalled())
    expect(refresh).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t update your cart. Nothing has changed — please try again.',
    )
  })

  it('says so when the cart could not be updated, instead of reloading as if it had', async () => {
    const user = userEvent.setup()
    vi.mocked(acceptCurrentPrices).mockResolvedValue({
      data: { error: 'Something went wrong updating your cart. Please try again.' },
    } as never)
    render(<AcceptPricesButton />)

    await user.click(screen.getByRole('button', { name: 'Accept the new prices' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong updating your cart. Please try again.',
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  it('accepts the new prices and reloads the cart to show them', async () => {
    const user = userEvent.setup()
    vi.mocked(acceptCurrentPrices).mockResolvedValue({ data: { ok: true } } as never)
    render(<AcceptPricesButton />)

    await user.click(screen.getByRole('button', { name: 'Accept the new prices' }))

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  it('cannot be pressed twice while accepting', async () => {
    const user = userEvent.setup()
    const pending = deferred()
    vi.mocked(acceptCurrentPrices).mockReturnValue(pending.promise as never)
    render(<AcceptPricesButton />)

    await user.click(screen.getByRole('button', { name: 'Accept the new prices' }))

    expect(screen.getByRole('button', { name: 'Accept the new prices' })).toBeDisabled()
    await act(async () => pending.resolve({ data: { ok: true } }))
    expect(screen.getByRole('button', { name: 'Accept the new prices' })).toBeEnabled()
  })
})
