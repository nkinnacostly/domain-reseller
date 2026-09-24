import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addDomainsToCart } from '@/features/cart/actions/cart'
import { CART_COUNT_EVENT } from '@/features/cart/lib/count'
import { MAX_CART_ITEMS } from '@/features/cart/lib/lines'
import { BulkAddSelected } from '../components/bulk-add-selected'

// The server action is the network boundary for this component.
vi.mock('@/features/cart/actions/cart', () => ({ addDomainsToCart: vi.fn() }))

const answer = (result: unknown) => vi.mocked(addDomainsToCart).mockResolvedValue(result as never)
const onAdded = vi.fn()

beforeEach(() => vi.clearAllMocks())

async function press(domains: string[]) {
  const user = userEvent.setup()
  render(<BulkAddSelected domains={domains} onAdded={onAdded} />)
  await user.click(screen.getByRole('button', { name: /to cart$/ }))
}

describe('BulkAddSelected (FR-S5)', () => {
  it('cannot be pressed with nothing selected, and says how to select', () => {
    render(<BulkAddSelected domains={[]} onAdded={onAdded} />)
    expect(screen.getByRole('button', { name: 'Add selected to cart' })).toBeDisabled()
    expect(screen.getByText('Tick the names you want, or select all available.')).toBeVisible()
  })

  it('shows a refusal and stays pressable', async () => {
    answer({ data: { error: "You've added a lot in the last few minutes." } })
    await press(['getpaid.com'])

    expect(await screen.findByRole('alert')).toHaveTextContent('added a lot')
    expect(screen.getByRole('button', { name: 'Add 1 to cart' })).toBeEnabled()
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('shows a server failure the same way', async () => {
    answer({ serverError: 'Something went wrong on our end. Please try again.' })
    await press(['getpaid.com'])
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
  })

  it('says nothing was added, and why, when every name was refused', async () => {
    answer({
      data: {
        count: 0,
        added: [],
        notAdded: [{ domain: 'getpaid.com', reason: 'Taken while you were looking' }],
      },
    })
    await press(['getpaid.com'])

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing could be added.getpaid.com — Taken while you were looking',
    )
    expect(screen.queryByRole('link', { name: 'View cart' })).not.toBeInTheDocument()
  })

  it('adds the names ticked, says which went in and which did not, and updates the badge', async () => {
    const badge = vi.fn()
    window.addEventListener(CART_COUNT_EVENT, badge)
    answer({
      data: {
        count: 3,
        added: ['getpaid.com'],
        notAdded: [{ domain: 'café.com', reason: "We couldn't confirm it's still free" }],
      },
    })
    await press(['getpaid.com', 'xn--caf-dma.com'])

    expect(addDomainsToCart).toHaveBeenCalledWith({ domains: ['getpaid.com', 'xn--caf-dma.com'] })
    expect(await screen.findByRole('status')).toHaveTextContent('Added 1 name to your cart.')
    expect(screen.getByText(/café\.com/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View cart' })).toHaveAttribute('href', '/cart')
    expect(onAdded).toHaveBeenCalledWith(['getpaid.com'])
    const [event] = badge.mock.calls[0] ?? []
    expect((event as CustomEvent).detail).toBe(3)
    window.removeEventListener(CART_COUNT_EVENT, badge)
  })

  it('says a cart holds 50 before it is pressed, and sends only the first 50', async () => {
    answer({ data: { count: 50, added: [], notAdded: [] } })
    const domains = Array.from({ length: 120 }, (_, index) => `name${index}.com`)
    await press(domains)

    expect(
      screen.getByText(
        `A cart holds up to ${MAX_CART_ITEMS} domains, so only the first ${MAX_CART_ITEMS} of the 120 you selected can go in now. Check those out, then add the rest.`,
      ),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: `Add the first ${MAX_CART_ITEMS} to cart` }),
    ).toBeVisible()
    expect(addDomainsToCart).toHaveBeenCalledWith({ domains: domains.slice(0, MAX_CART_ITEMS) })
  })
})
