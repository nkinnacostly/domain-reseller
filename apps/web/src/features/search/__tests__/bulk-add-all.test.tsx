import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addDomainsToCart } from '@/features/cart/actions/cart'
import { CART_COUNT_EVENT } from '@/features/cart/lib/count'
import { BulkAddAll } from '../components/bulk-add-all'

// The server action is the network boundary for this component.
vi.mock('@/features/cart/actions/cart', () => ({ addDomainsToCart: vi.fn() }))

const answer = (result: unknown) => vi.mocked(addDomainsToCart).mockResolvedValue(result as never)

beforeEach(() => vi.clearAllMocks())

async function pressAddAll(domains = ['getpaid.com', 'xn--caf-dma.com']) {
  const user = userEvent.setup()
  render(<BulkAddAll domains={domains} />)
  await user.click(screen.getByRole('button', { name: /available (name )?to cart$/ }))
}

describe('BulkAddAll (FR-S5)', () => {
  it('shows a refusal and stays pressable', async () => {
    answer({ data: { error: "You've added a lot in the last few minutes." } })
    await pressAddAll()

    expect(await screen.findByRole('alert')).toHaveTextContent('added a lot')
    expect(screen.getByRole('button', { name: 'Add all 2 available to cart' })).toBeEnabled()
  })

  it('shows a server failure the same way', async () => {
    answer({ serverError: 'Something went wrong on our end. Please try again.' })
    await pressAddAll()
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
    await pressAddAll(['getpaid.com'])

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing could be added.getpaid.com — Taken while you were looking',
    )
    expect(screen.queryByRole('link', { name: 'View cart' })).not.toBeInTheDocument()
  })

  it('adds the names it was shown, says which went in and which did not, and updates the badge', async () => {
    const badge = vi.fn()
    window.addEventListener(CART_COUNT_EVENT, badge)
    answer({
      data: {
        count: 3,
        added: ['getpaid.com'],
        notAdded: [{ domain: 'café.com', reason: "We couldn't confirm it's still free" }],
      },
    })

    await pressAddAll()

    expect(addDomainsToCart).toHaveBeenCalledWith({
      domains: ['getpaid.com', 'xn--caf-dma.com'],
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Added 1 name to your cart.')
    expect(screen.getByRole('status')).toHaveTextContent('café.com')
    expect(screen.getByRole('link', { name: 'View cart' })).toHaveAttribute('href', '/cart')
    expect(badge).toHaveBeenCalledWith(expect.objectContaining({ detail: 3 }))
    window.removeEventListener(CART_COUNT_EVENT, badge)
  })

  it('counts in the plural', async () => {
    answer({ data: { count: 2, added: ['a.com', 'b.com'], notAdded: [] } })
    await pressAddAll(['a.com', 'b.com'])
    expect(await screen.findByRole('status')).toHaveTextContent('Added 2 names to your cart.')
  })

  it('says so while it works, so nobody presses twice (S12)', async () => {
    vi.mocked(addDomainsToCart).mockReturnValue(new Promise(() => {}) as never)
    await pressAddAll()
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled()
  })

  it('names a single free name plainly', () => {
    render(<BulkAddAll domains={['getpaid.com']} />)
    expect(screen.getByRole('button', { name: 'Add the available name to cart' })).toBeEnabled()
  })
})
