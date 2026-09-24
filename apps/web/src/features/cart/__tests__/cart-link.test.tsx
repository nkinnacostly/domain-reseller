import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CartLink } from '../components/cart-link'
import { announceCartCount, CartCountSync } from '../lib/count'

function setCountCookie(value: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: the badge reads this cookie; the test sets it
  document.cookie = `dr_cart_count=${value}; path=/`
}

afterEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: clearing what the test set
  document.cookie = 'dr_cart_count=; path=/; max-age=0'
})

describe('CartLink — the header badge', () => {
  it('is just “Cart”, with no number, when the cart is empty', () => {
    render(<CartLink />)
    const link = screen.getByRole('link', { name: 'Cart' })
    expect(link).toHaveAttribute('href', '/cart')
    expect(link).not.toHaveTextContent(/\d/)
  })

  it('shows the count carried in the cookie on a prerendered page', () => {
    setCountCookie('3')
    render(<CartLink />)
    const link = screen.getByRole('link', { name: 'Cart, 3 domains' })
    expect(link).toHaveTextContent('3')
  })

  it('says “1 domain”, not “1 domains”', () => {
    setCountCookie('1')
    render(<CartLink tone="default" />)
    expect(screen.getByRole('link', { name: 'Cart, 1 domain' })).toBeInTheDocument()
  })

  it('ignores a cookie that is not a number', () => {
    setCountCookie('lots')
    render(<CartLink />)
    expect(screen.getByRole('link', { name: 'Cart' })).toBeInTheDocument()
  })

  it('follows an add or remove on the same page without a reload', () => {
    render(<CartLink />)
    act(() => announceCartCount(2))
    expect(screen.getByRole('link', { name: 'Cart, 2 domains' })).toBeInTheDocument()
    act(() => announceCartCount(0))
    expect(screen.getByRole('link', { name: 'Cart' })).toBeInTheDocument()
  })

  it('stops listening once it is gone', () => {
    const { unmount } = render(<CartLink />)
    unmount()
    expect(() => act(() => announceCartCount(4))).not.toThrow()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('CartCountSync — the cart page corrects the hint', () => {
  it('rewrites the cookie and the badge to match the real cart', () => {
    setCountCookie('9')
    render(
      <>
        <CartLink />
        <CartCountSync count={2} />
      </>,
    )
    expect(document.cookie).toContain('dr_cart_count=2')
    expect(screen.getByRole('link', { name: 'Cart, 2 domains' })).toBeInTheDocument()
  })

  it('follows the cart as it changes', () => {
    const { rerender } = render(
      <>
        <CartLink />
        <CartCountSync count={2} />
      </>,
    )
    rerender(
      <>
        <CartLink />
        <CartCountSync count={1} />
      </>,
    )
    expect(document.cookie).toContain('dr_cart_count=1')
    expect(screen.getByRole('link', { name: 'Cart, 1 domain' })).toBeInTheDocument()
  })

  it('renders nothing of its own', () => {
    const { container } = render(<CartCountSync count={0} />)
    expect(container).toBeEmptyDOMElement()
  })
})
