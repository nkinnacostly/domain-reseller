import { render, screen, within } from '@testing-library/react'
import { cookies } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderView } from '@/features/admin/components/orders/order-view'
import { OrdersView } from '@/features/admin/components/orders/orders-view'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { fakeService, ids } from './fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  },
}))
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute: vi.fn(), isPending: false, result: {} }),
}))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
// requireAdmin is React's cache(): outside a render it would remember one answer.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T,>(fn: T) => fn,
}))

const order = {
  id: ids.order,
  order_number: 'ND-001035',
  test_mode: false,
  created_at: '2026-10-02T09:00:00Z',
  updated_at: '2026-10-02T09:05:00Z',
  paid_at: '2026-10-02T09:01:00Z',
  payment_checked_at: null,
  user_id: ids.user,
  status: 'completed',
  subtotal_kobo: 1_870_000,
  vat_kobo: 140_250,
  vat_pct: 7.5,
  total_kobo: 2_010_250,
  invoice_number: 'INV-000002',
  tx_ref: 'MDH-4fb8afe8-1a3d-4e5f-9a7b-6c5d4e3f2a1b',
  float_check: 'covered',
  nameservers: null,
}

function signedIn(side?: 'live' | 'test') {
  vi.mocked(cookies).mockResolvedValue({
    get: () => (side ? { name: 'dr_admin_side', value: side } : undefined),
  } as never)
  const session = sessionClient({
    rpc: {
      admin_whoami: { data: whoami() },
      admin_customers: { data: [] },
      admin_funnel: {
        data: {
          cartAdds: 0,
          cartAddsSince: null,
          created: 1,
          paid: 1,
          completed: 1,
          partial: 0,
          failed: 0,
          cancelled: 0,
          awaiting: 0,
          inFlight: 0,
          medianSecsToPay: 60,
          medianSecsToSettle: 120,
        },
      },
    },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => vi.clearAllMocks())

describe('the orders list page', () => {
  it('shows the funnel, the filters and the side’s orders, with the side switch', async () => {
    signedIn()
    fakeService((read) => {
      if (read.table === 'admin_orders_v') return { data: [order], count: 1 }
      if (read.table === 'order_items')
        return { data: [{ order_id: ids.order, item_type: 'register' }] }
      return undefined
    })
    render(await OrdersView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('heading', { level: 1, name: 'Orders' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Funnel' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search orders' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '1 order' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('table')).getByRole('link', { name: 'ND-001035' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the funnel and filters when the list cannot be read', async () => {
    signedIn('test')
    fakeService(() => ({ error: { message: 'boom', code: '57014' } }))
    render(await OrdersView({ searchParams: Promise.resolve({ status: 'paid' }) }))
    expect(screen.getByText('The orders couldn’t be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Funnel' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Orders' })).toBeInTheDocument()
  })
})

describe('the order page', () => {
  it('shows the order read only, with its parts', async () => {
    signedIn()
    fakeService((read) => (read.table === 'admin_orders_v' ? { data: [order] } : { data: [] }))
    render(await OrderView({ params: Promise.resolve({ id: ids.order }) }))
    expect(screen.getByRole('heading', { level: 1, name: 'Order ND-001035' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Admin/Orders/ND-001035',
    )
    expect(
      screen.getByText(/Read only: an order changes through its jobs and refunds\./),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Summary' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Lines (0)' })).toBeInTheDocument()
    // No action on an order (§5.2): the only buttons copy, switch the side or retry.
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAccessibleName(/^(Copy .+|Live|Test)$/)
    }
  })

  it('says an order is not on this side, with the way back', async () => {
    signedIn('test')
    fakeService(() => ({ data: [] }))
    render(await OrderView({ params: Promise.resolve({ id: ids.order }) }))
    expect(screen.getByText('No order with this id on the Test side.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to orders' })).toHaveAttribute(
      'href',
      '/admin/orders',
    )
  })

  it('shows an error with a way on when the order cannot be read', async () => {
    signedIn()
    fakeService(() => ({ error: { message: 'boom' } }))
    render(await OrderView({ params: Promise.resolve({ id: ids.order }) }))
    expect(screen.getByRole('alert')).toHaveTextContent('This order couldn’t be loaded.')
    expect(screen.getByRole('heading', { level: 1, name: 'Order' })).toBeInTheDocument()
  })
})
