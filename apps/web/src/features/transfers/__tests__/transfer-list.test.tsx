import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TransferList } from '../components/transfer-list'
import type { TransferRow } from '../queries/transfers'

const row = (over: Partial<TransferRow> = {}): TransferRow => ({
  id: 'd1',
  domainName: 'getpaid.com',
  status: 'transfer_pending',
  testMode: false,
  startedAt: '2026-09-24T09:00:00Z',
  submittedAt: '2026-09-24T09:20:00Z',
  orderId: 'o1',
  orderNumber: 'ND-001050',
  ...over,
})

describe('TransferList (PRD E9)', () => {
  it('invites a first transfer when there are none', () => {
    render(<TransferList transfers={[]} />)
    expect(screen.getByText(/haven’t transferred a domain/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Check a domain you own' })).toHaveAttribute(
      'href',
      '/transfer',
    )
  })

  it('puts transfers still moving above finished ones', () => {
    render(
      <TransferList
        transfers={[
          row({ id: 'a', domainName: 'arrived.com', status: 'active' }),
          row({ id: 'b', domainName: 'moving.com' }),
          row({ id: 'c', domainName: 'refused.com', status: 'transfer_rejected' }),
        ]}
      />,
    )
    const open = screen.getByRole('list', { name: 'In progress' })
    const finished = screen.getByRole('list', { name: 'Finished' })
    expect(within(open).getByText('moving.com')).toBeInTheDocument()
    expect(within(finished).getByText('arrived.com')).toBeInTheDocument()
    expect(within(finished).getByText('refused.com')).toBeInTheDocument()
  })

  it('links a domain once it has arrived, and the order always', () => {
    render(<TransferList transfers={[row({ status: 'active' })]} />)
    expect(screen.getByRole('link', { name: 'getpaid.com' })).toHaveAttribute(
      'href',
      '/app/domains/getpaid.com',
    )
    expect(screen.getByRole('link', { name: 'Order ND-001050' })).toHaveAttribute(
      'href',
      '/app/orders/o1',
    )
  })

  it('does not link a domain that has not arrived, and says what happens next', () => {
    render(<TransferList transfers={[row({ submittedAt: null, status: 'transfer_requested' })]} />)
    expect(screen.queryByRole('link', { name: 'getpaid.com' })).not.toBeInTheDocument()
    expect(screen.getByText(/We send the request to the registry shortly/)).toBeInTheDocument()
    expect(screen.queryByText(/At the registry/)).not.toBeInTheDocument()
  })

  it('shows when the registry took it, and marks test transfers', () => {
    render(<TransferList transfers={[row({ testMode: true, orderId: null })]} />)
    expect(screen.getByText(/At the registry 24 Sept 2026/)).toBeInTheDocument()
    expect(screen.getByText('test')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Order/ })).not.toBeInTheDocument()
  })
})
