import { formatNaira } from '@dr/shared'
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RefreshWhile } from '@/components/common/refresh-while'
import { OrderRefunds } from '../components/order-refunds'
import { OrderStatus } from '../components/order-status'
import type { OrderRefund } from '../queries/orders'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

describe('OrderStatus', () => {
  it.each([
    ['awaiting_payment', 'Awaiting payment'],
    ['paid', 'Paid — registration queued'],
    ['provisioning', 'Registering'],
    ['completed', 'Completed'],
    ['partially_failed', 'Partly failed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ])('reads %s as “%s”', (status, label) => {
    render(<OrderStatus status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('shows a status it does not know as it is, rather than nothing', () => {
    render(<OrderStatus status="on_hold" />)
    expect(screen.getByText('on_hold')).toBeInTheDocument()
  })

  it.each([
    ['paid', 'Paid — renewal queued'],
    ['provisioning', 'Renewing'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
  ])('reads a renewal order that is %s as “%s”', (status, label) => {
    render(<OrderStatus status={status} kind="renew" />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

const refund = (overrides: Partial<OrderRefund> = {}): OrderRefund => ({
  id: 'refund-1',
  domain: 'getpaid.com',
  reason: 'registration_failed',
  amountKobo: 1_840_000,
  state: 'processing',
  refundedAt: null,
  testMode: false,
  ...overrides,
})

describe('OrderRefunds (FR-R3)', () => {
  it('shows nothing when the order has no refunds', () => {
    const { container } = render(<OrderRefunds refunds={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the domain a failed registration refunds, with the amount and its state', () => {
    render(<OrderRefunds refunds={[refund()]} />)
    const section = screen.getByRole('region', { name: 'Refunds' })
    const [item] = within(section).getAllByRole('listitem')
    expect(item).toHaveTextContent('getpaid.com')
    expect(item).toHaveTextContent('Being processed')
    expect(item).toHaveTextContent('Nothing is needed from you.')
    expect(item).toHaveTextContent(formatNaira(1_840_000))
  })

  it('says when money was returned, as a Lagos date', () => {
    render(
      <OrderRefunds
        refunds={[
          refund({
            reason: 'duplicate_charge',
            domain: null,
            state: 'refunded',
            // 23:30 UTC is already the next day in Lagos.
            refundedAt: '2026-09-23T23:30:00.000Z',
          }),
        ]}
      />,
    )
    const item = screen.getByRole('listitem')
    expect(item).toHaveTextContent('A second charge for this order')
    expect(item).toHaveTextContent('Refunded')
    expect(item).toHaveTextContent(/Returned on 24 Sept 2026 to the card or account you paid with/)
  })

  it('lists each refund on the order', () => {
    render(
      <OrderRefunds
        refunds={[
          refund(),
          refund({ id: 'refund-2', domain: 'paidly.com', state: 'sent', amountKobo: 3_710_000 }),
        ]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[1]).toHaveTextContent('paidly.com')
    expect(items[1]).toHaveTextContent('On its way')
    expect(items[1]).toHaveTextContent(formatNaira(3_710_000))
  })

  it('says a test refund moves no money', () => {
    render(<OrderRefunds refunds={[refund({ testMode: true })]} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('Test refund — no money moves.')
  })

  it('shows a state it does not know as it is', () => {
    render(<OrderRefunds refunds={[refund({ state: 'held' as OrderRefund['state'] })]} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('held')
  })
})

describe('RefreshWhile', () => {
  let visibility: DocumentVisibilityState

  beforeEach(() => {
    refresh.mockReset()
    vi.useFakeTimers()
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('re-reads the order every few seconds while it is settling', () => {
    render(<RefreshWhile active />)
    vi.advanceTimersByTime(3_999)
    expect(refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(8_000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('follows the interval it is given', () => {
    render(<RefreshWhile active everyMs={1_000} />)
    vi.advanceTimersByTime(3_000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('does nothing once the order has settled', () => {
    render(<RefreshWhile active={false} />)
    vi.advanceTimersByTime(20_000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('stops as soon as the server renders it inactive', () => {
    const { rerender } = render(<RefreshWhile active />)
    vi.advanceTimersByTime(4_000)
    rerender(<RefreshWhile active={false} />)
    vi.advanceTimersByTime(20_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not refresh while the tab is hidden', () => {
    render(<RefreshWhile active />)
    visibility = 'hidden'
    vi.advanceTimersByTime(12_000)
    expect(refresh).not.toHaveBeenCalled()
    visibility = 'visible'
    vi.advanceTimersByTime(4_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stops when the page is left', () => {
    const { unmount } = render(<RefreshWhile active />)
    unmount()
    vi.advanceTimersByTime(20_000)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('renders nothing', () => {
    const { container } = render(<RefreshWhile active />)
    expect(container).toBeEmptyDOMElement()
  })
})
