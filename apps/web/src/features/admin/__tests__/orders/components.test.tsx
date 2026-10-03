import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OrderFunnelStrip } from '@/features/admin/components/orders/order-funnel'
import {
  OrderActivity,
  OrderIncidents,
  OrderLines,
  OrderPayments,
  OrderRefunds,
  OrderTrace,
} from '@/features/admin/components/orders/order-sections'
import { OrderBody } from '@/features/admin/components/orders/order-view'
import {
  OrderSortLinks,
  OrderStatusChips,
  OrdersFilterForm,
  OrdersSearch,
} from '@/features/admin/components/orders/orders-filters'
import { OrderSkeleton, OrdersSkeleton } from '@/features/admin/components/orders/orders-skeleton'
import { OrdersList } from '@/features/admin/components/orders/orders-view'
import {
  CAPPED_NOTICE,
  EMAIL_REFUSED,
  LIST_ERROR,
  NO_CALLS,
  SEARCH_NOT_EMAIL,
  SECTION_ERROR,
  SSL_TRACE_NOTE,
  STUCK_NOTE,
  UNKNOWN_SEARCH,
} from '@/features/admin/lib/orders-copy'
import { parseOrderListParams } from '@/features/admin/lib/orders-params'
import type {
  OrderDetail,
  OrderLine,
  OrderList,
  OrderListRow,
} from '@/features/admin/queries/orders'
import { ids } from './fake-db'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const row: OrderListRow = {
  id: ids.order,
  orderNumber: 'ND-001035',
  testMode: true,
  createdAt: '2026-10-02T09:00:00Z',
  paidAt: null,
  userId: ids.user,
  customer: 'e•••@example.com',
  status: 'awaiting_payment',
  totalKobo: 2_010_250,
  invoiceNumber: null,
  floatCheck: 'shortfall_test_mode',
  lines: [{ item_type: 'register' }, { item_type: 'ssl' }],
}

const list = (overrides: Partial<OrderList> = {}): OrderList => ({
  rows: [row],
  total: 1,
  capped: false,
  stuckNote: null,
  ...overrides,
})

const hrefs = (container: HTMLElement) =>
  [...container.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '')

describe('OrdersList', () => {
  it('lists each order with its number, buyer masked, kinds, total and states in words', () => {
    const { container } = render(
      <OrdersList side="test" params={parseOrderListParams({})} list={list()} />,
    )
    const table = screen.getByRole('table')
    expect(within(table).getByRole('link', { name: 'ND-001035' })).toHaveAttribute(
      'href',
      `/admin/orders/${ids.order}`,
    )
    expect(within(table).getByText('Test')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'e•••@example.com' })).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}`,
    )
    expect(within(table).getByText('Registration, Certificate')).toBeInTheDocument()
    expect(within(table).getByText('₦20,103')).toBeInTheDocument()
    expect(within(table).getByText('Awaiting payment')).toBeInTheDocument()
    expect(within(table).getByText('Not paid')).toBeInTheDocument()
    expect(within(table).getByText('Short (test mode)')).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: /Placed/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(screen.getByText('1 in all')).toBeInTheDocument()
    expect(hrefs(container)).toContain('/admin/orders?sort=total')
  })

  it('names a buyer it could not mask by the account’s short id, and none as a dash', () => {
    render(
      <OrdersList
        side="live"
        params={parseOrderListParams({})}
        list={list({
          rows: [
            { ...row, id: ids.order, customer: undefined },
            { ...row, id: ids.other, orderNumber: 'ND-001036', userId: null },
          ],
          total: 2,
        })}
      />,
    )
    const table = screen.getByRole('table')
    expect(within(table).getByRole('link', { name: 'Account 2a2b2c2d' })).toBeInTheDocument()
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('refuses an email search, keeps it out of every link, and points to Customers', () => {
    const { container } = render(
      <OrdersList
        side="live"
        params={parseOrderListParams({ q: 'ada@example.com', status: 'paid' })}
        list={null}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(EMAIL_REFUSED)
    expect(screen.getByRole('link', { name: 'Go to Customers' })).toHaveAttribute(
      'href',
      '/admin/customers',
    )
    expect(screen.getByRole('link', { name: 'Show orders without a search' })).toHaveAttribute(
      'href',
      '/admin/orders?status=paid',
    )
    for (const href of hrefs(container)) expect(href).not.toMatch(/@|%40/)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('says a search it cannot read was not run', () => {
    render(<OrdersList side="live" params={parseOrderListParams({ q: 'hello' })} list={null} />)
    expect(screen.getByRole('status')).toHaveTextContent(UNKNOWN_SEARCH)
    expect(screen.queryByRole('link', { name: 'Go to Customers' })).not.toBeInTheDocument()
  })

  it('shows an error with a way on when the list could not be read', () => {
    render(<OrdersList side="live" params={parseOrderListParams({})} list={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent(LIST_ERROR)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('says the side has no orders, or that the filters matched none', () => {
    const { unmount } = render(
      <OrdersList
        side="test"
        params={parseOrderListParams({})}
        list={list({ rows: [], total: 0 })}
      />,
    )
    expect(screen.getByText('No orders on the Test side yet.')).toBeInTheDocument()
    unmount()
    render(
      <OrdersList
        side="live"
        params={parseOrderListParams({ kind: 'ssl' })}
        list={list({ rows: [], total: 0, capped: true })}
      />,
    )
    expect(screen.getByText('No orders match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute(
      'href',
      '/admin/orders',
    )
    expect(screen.getByText(CAPPED_NOTICE)).toBeInTheDocument()
  })

  it('says a page past the end is empty, with the way back to the first', () => {
    render(
      <OrdersList
        side="live"
        params={parseOrderListParams({ page: '9', kind: 'renew' })}
        list={list({ rows: [], total: 30 })}
      />,
    )
    expect(screen.getByText('Nothing on page 9.')).toBeInTheDocument()
    expect(screen.getByText('The list has 2 pages.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/orders?kind=renew',
    )
  })

  it('explains a stuck list without its threshold, and pages a long list', () => {
    render(
      <OrdersList
        side="test"
        params={parseOrderListParams({ stuck: '1', page: '2' })}
        list={list({ total: 60, stuckNote: 'test_admin' })}
      />,
    )
    expect(screen.getByText(STUCK_NOTE.test_admin)).toBeInTheDocument()
    expect(screen.getByText('Page 2 of 3 · 60 in all')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/admin/orders?stuck=1',
    )
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/admin/orders?page=3&stuck=1',
    )
  })
})

describe('the orders filters', () => {
  it('refuses an email in the search box before it is sent, and keeps the other filters', () => {
    const params = parseOrderListParams({
      status: 'paid',
      kind: 'renew',
      stuck: '1',
      sort: 'total',
      q: 'ND-1035',
    })
    const { container } = render(<OrdersSearch params={params} />)
    const box = screen.getByRole('searchbox', { name: 'Search orders' })
    expect(box).toHaveAttribute('pattern', '[^@]*')
    expect(box).toHaveAttribute('title', SEARCH_NOT_EMAIL)
    expect(box).toHaveValue('ND-1035')
    expect(box).toHaveAccessibleDescription(/Find a customer by email on the Customers page/)
    const kept = Object.fromEntries(
      [...container.querySelectorAll('input[type=hidden]')].map((input) => [
        input.getAttribute('name'),
        input.getAttribute('value'),
      ]),
    )
    expect(kept).toEqual({ status: 'paid', sort: 'total', kind: 'renew', stuck: '1' })
    // jsdom checks the pattern as a browser does.
    ;(box as HTMLInputElement).value = 'ada@example.com'
    expect((box as HTMLInputElement).validity.patternMismatch).toBe(true)
    ;(box as HTMLInputElement).value = 'getpaid.com'
    expect((box as HTMLInputElement).validity.valid).toBe(true)
  })

  it('filters by kind, dates and stuck in one GET form that keeps the search', () => {
    const params = parseOrderListParams({ kind: 'ssl', from: '2026-09-01', q: 'getpaid.com' })
    const { container } = render(<OrdersFilterForm params={params} />)
    const form = screen.getByRole('form', { name: 'Filter orders' })
    expect(form).toHaveAttribute('method', 'get')
    expect(screen.getByLabelText('Kind')).toHaveValue('ssl')
    expect(screen.getByLabelText('Placed from')).toHaveValue('2026-09-01')
    expect(screen.getByLabelText('Placed to')).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: 'Stuck only' })).not.toBeChecked()
    expect(container.querySelector('input[name=q]')).toHaveValue('getpaid.com')
    expect(screen.getByRole('link', { name: 'Clear all' })).toHaveAttribute('href', '/admin/orders')
  })

  it('toggles status chips as links, the chosen one marked in words', () => {
    render(<OrderStatusChips params={parseOrderListParams({ status: 'paid' })} />)
    const paid = screen.getByRole('link', { name: 'Paid' })
    expect(paid).toHaveAttribute('aria-current', 'true')
    expect(paid).toHaveAttribute('href', '/admin/orders')
    expect(screen.getByRole('link', { name: 'Failed' })).toHaveAttribute(
      'href',
      '/admin/orders?status=paid%2Cfailed',
    )
  })

  it('sorts the cards below xl, saying which sort is current and how to reverse it', () => {
    render(<OrderSortLinks params={parseOrderListParams({ sort: 'paid', dir: 'asc' })} />)
    const nav = screen.getByRole('navigation', { name: 'Sort orders' })
    const paid = within(nav).getByRole('link', { name: /^Paid/ })
    expect(paid).toHaveAttribute('aria-current', 'true')
    expect(paid).toHaveAccessibleName('Paid (sorted ascending; select to reverse)')
    expect(paid).toHaveAttribute('href', '/admin/orders?sort=paid')
    expect(within(nav).getByRole('link', { name: /^Placed/ })).toHaveAttribute(
      'href',
      '/admin/orders',
    )
  })
})

describe('OrderFunnelStrip', () => {
  const range = { from: '2026-09-04', to: '2026-10-03' }
  const funnel = {
    cartAdds: 12,
    cartAddsSince: '2026-10-01',
    created: 5,
    paid: 4,
    completed: 3,
    partial: 0,
    failed: 1,
    cancelled: 0,
    awaiting: 1,
    inFlight: 0,
    medianSecsToPay: 95,
    medianSecsToSettle: null,
  }

  it('shows each stage, and since when cart adds are counted', () => {
    render(<OrderFunnelStrip funnel={funnel} range={range} />)
    const region = screen.getByRole('region', { name: 'Funnel' })
    expect(
      within(region).getByText('Orders placed 4 Sept 2026 – 3 Oct 2026 (WAT)'),
    ).toBeInTheDocument()
    expect(within(region).getByText('counted since 1 Oct 2026')).toBeInTheDocument()
    expect(within(region).getByText('2 min')).toBeInTheDocument()
  })

  it('says cart adds are not counted yet, and errors with a way on', () => {
    const { unmount } = render(
      <OrderFunnelStrip funnel={{ ...funnel, cartAddsSince: null }} range={range} />,
    )
    expect(screen.getByText('not counted yet')).toBeInTheDocument()
    unmount()
    render(<OrderFunnelStrip funnel={null} range={range} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The funnel couldn’t be read.')
  })
})

const line: OrderLine = {
  id: ids.line,
  itemType: 'register',
  domain: 'getpaid.com',
  periodYears: 1,
  priceKobo: 1_870_000,
  renewalKobo: 1_870_000,
  renewalYears: 1,
  status: 'failed',
  failureCode: 'DOMAIN_TAKEN',
  autoRenew: true,
  privacy: false,
  domainId: ids.domain,
  cost: {
    supplier_cost_cents: 1131,
    icann_fee_cents: 20,
    recorded_at: '2026-10-02T09:00:00Z',
  },
  jobIds: [ids.job],
}

const sslLine: OrderLine = {
  ...line,
  id: ids.sslLine,
  itemType: 'ssl',
  domain: 'shop.getpaid.com',
  status: 'completed',
  failureCode: null,
  renewalKobo: 2_500_000,
  domainId: null,
  cost: null,
  jobIds: [],
}

const detail: OrderDetail = {
  order: {
    id: ids.order,
    orderNumber: 'ND-001035',
    testMode: true,
    status: 'partially_failed',
    createdAt: '2026-10-02T09:00:00Z',
    updatedAt: '2026-10-02T09:05:00Z',
    paidAt: '2026-10-02T09:01:00Z',
    paymentCheckedAt: null,
    userId: ids.user,
    customer: 'e•••@example.com',
    subtotalKobo: 4_370_000,
    vatKobo: 327_750,
    vatPct: 7.5,
    totalKobo: 4_697_750,
    invoiceNumber: 'TEST-INV-000001',
    txRef: 'MDH-4fb8afe8-1a3d-4e5f-9a7b-6c5d4e3f2a1b',
    floatCheck: 'covered',
    nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  },
  lines: { ok: true, data: [line, sslLine] },
  payments: {
    ok: true,
    data: [
      {
        id: ids.payment,
        providerReference: '9001',
        amountKobo: 4_697_750,
        chargedKobo: null,
        feeKobo: 65_768,
        absorbed: null,
        status: 'successful',
        method: 'card',
        createdAt: '2026-10-02T09:01:00Z',
      },
    ],
  },
  refunds: {
    ok: true,
    data: [
      {
        id: ids.refund,
        reason: 'registration_failed',
        status: 'held',
        amountKobo: 2_010_250,
        orderItemId: ids.line,
        createdAt: '2026-10-02T09:03:00Z',
        completedAt: null,
        lastErrorCode: 'OVER_LIMIT',
      },
    ],
  },
  incidents: {
    ok: true,
    data: [
      {
        id: 42,
        kind: 'duplicate_charge',
        createdAt: '2026-10-02T09:02:00Z',
        resolvedAt: '2026-10-02T10:00:00Z',
        resolvedBy: 'owner',
      },
    ],
  },
  trace: {
    ok: true,
    data: {
      jobs: [
        {
          id: ids.job,
          kind: 'register_domain',
          status: 'failed',
          attempts: 2,
          orderItemId: ids.line,
          createdAt: '2026-10-02T09:01:00Z',
          finishedAt: '2026-10-02T09:02:00Z',
          lastErrorCode: 'DOMAIN_TAKEN',
        },
      ],
      calls: [
        {
          id: 7,
          createdAt: '2026-10-02T09:01:30Z',
          operation: 'RegisterWithContactInfo',
          outcome: 'rejected',
          httpStatus: 403,
          durationMs: 2400,
          errorCode: 'API_310',
          jobId: ids.job,
        },
      ],
    },
  },
  activity: {
    ok: true,
    data: {
      domains: new Map([[ids.domain, 'getpaid.com']]),
      events: [
        {
          id: 11,
          domainId: ids.domain,
          eventType: 'nameservers_requested',
          actorType: 'user',
          createdAt: '2026-10-02T09:02:00Z',
        },
      ],
    },
  },
}

describe('one order', () => {
  it('summarises the order, the buyer masked and the references copyable', () => {
    render(<OrderBody detail={detail} />)
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByText('Partly failed')).toBeInTheDocument()
    expect(within(summary).getByRole('link', { name: 'e•••@example.com' })).toBeInTheDocument()
    expect(within(summary).getByText('VAT (7.5%)')).toBeInTheDocument()
    expect(within(summary).getByText('₦46,978')).toBeInTheDocument()
    expect(within(summary).getByText('ns1.vercel-dns.com, ns2.vercel-dns.com')).toBeInTheDocument()
    expect(
      within(summary).getByRole('button', { name: 'Copy payment reference' }),
    ).toBeInTheDocument()
    expect(within(summary).getByRole('button', { name: 'Copy order id' })).toBeInTheDocument()
  })

  it('shows each line with its renewal price, recorded cost and job (N8, D13)', () => {
    render(<OrderLines lines={detail.lines} />)
    const region = screen.getByRole('region', { name: 'Lines (2)' })
    const table = within(region).getByRole('table')
    expect(within(table).getByRole('link', { name: 'getpaid.com' })).toHaveAttribute(
      'href',
      `/admin/domains/${ids.domain}`,
    )
    expect(within(table).getByText('Renews at ₦18,700/yr')).toBeInTheDocument()
    expect(
      within(table).getByText('$11.31 + $0.20 ICANN (recorded at checkout)'),
    ).toBeInTheDocument()
    expect(within(table).getByText('Not recorded')).toBeInTheDocument()
    expect(within(table).getByText('DOMAIN_TAKEN')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Job 6a6b6c6d' })).toHaveAttribute(
      'href',
      `/admin/queue/jobs/${ids.job}`,
    )
    expect(within(table).getByText('A new one is ₦25,000 at today’s price')).toBeInTheDocument()
    expect(within(table).getByText('On the certificate’s page')).toBeInTheDocument()
    expect(within(table).getByText('1-year subscription')).toBeInTheDocument()
  })

  it('shows payments with the fee from the view, and says what Flutterwave did not report', () => {
    render(<OrderPayments payments={detail.payments} />)
    const table = within(screen.getByRole('region', { name: 'Payments (1)' })).getByRole('table')
    expect(within(table).getByText('₦658')).toBeInTheDocument()
    expect(within(table).getAllByText('Not reported')).toHaveLength(2)
    expect(within(table).getByText('9001')).toBeInTheDocument()
    expect(within(table).getByText('Card')).toBeInTheDocument()
    expect(within(table).getByText('Successful')).toBeInTheDocument()
  })

  it('links refunds and incidents to where they are worked', () => {
    render(
      <>
        <OrderRefunds refunds={detail.refunds} lines={new Map([[ids.line, 'getpaid.com']])} />
        <OrderIncidents incidents={detail.incidents} />
      </>,
    )
    const refunds = within(screen.getByRole('region', { name: 'Refunds (1)' })).getByRole('table')
    expect(within(refunds).getByRole('link', { name: 'Refund 7a7b7c7d' })).toHaveAttribute(
      'href',
      `/admin/refunds/${ids.refund}`,
    )
    expect(within(refunds).getByText('Held for approval')).toBeInTheDocument()
    expect(within(refunds).getByText('Registration failed')).toBeInTheDocument()
    expect(within(refunds).getByText('getpaid.com')).toBeInTheDocument()
    const incidents = within(
      screen.getByRole('region', { name: 'Payment incidents (1)' }),
    ).getByRole('table')
    expect(within(incidents).getByRole('link', { name: 'Incident 42' })).toHaveAttribute(
      'href',
      '/admin/refunds/incidents#incident-42',
    )
    expect(within(incidents).getByText('Resolved')).toBeInTheDocument()
    expect(within(incidents).getByText(/by owner$/)).toBeInTheDocument()
  })

  it('traces the jobs and their supplier calls, outcomes in words', () => {
    render(
      <OrderTrace
        trace={detail.trace}
        lines={new Map([[ids.line, 'getpaid.com']])}
        hasCertificates
        callsShown={1}
      />,
    )
    const region = screen.getByRole('region', { name: 'Registry jobs and supplier calls' })
    expect(within(region).getByText(SSL_TRACE_NOTE)).toBeInTheDocument()
    const [jobs, calls] = within(region).getAllByRole('table')
    if (!jobs || !calls) throw new Error('two tables')
    expect(within(jobs).getByText('Registration')).toBeInTheDocument()
    expect(within(jobs).getByText('Failed')).toBeInTheDocument()
    expect(within(calls).getByText('RegisterWithContactInfo')).toBeInTheDocument()
    expect(within(calls).getByText('Refused')).toBeInTheDocument()
    expect(within(calls).getByText('2.4 s')).toBeInTheDocument()
    expect(within(calls).getByText('API_310')).toBeInTheDocument()
    expect(within(region).getByText('(the latest 1)')).toBeInTheDocument()
  })

  it('says when no supplier call is recorded, and shows the domain’s activity', () => {
    render(
      <>
        <OrderTrace
          trace={{ ok: true, data: { jobs: [], calls: [] } }}
          lines={new Map()}
          hasCertificates={false}
          callsShown={100}
        />
        <OrderActivity activity={detail.activity} />
      </>,
    )
    expect(screen.getByText(NO_CALLS)).toBeInTheDocument()
    expect(screen.queryByText(SSL_TRACE_NOTE)).not.toBeInTheDocument()
    const activity = screen.getByRole('region', { name: 'Domain activity since the order (1)' })
    expect(within(activity).getByText('Nameservers requested · getpaid.com')).toBeInTheDocument()
    expect(within(activity).getByText('By the customer')).toBeInTheDocument()
  })

  it('gives a part that failed its own error, and leaves the rest', () => {
    render(
      <OrderBody
        detail={{
          ...detail,
          lines: { ok: false },
          trace: { ok: false },
          activity: { ok: false },
        }}
      />,
    )
    expect(screen.getAllByText(SECTION_ERROR)).toHaveLength(3)
    expect(screen.getByRole('region', { name: 'Lines' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Payments (1)' })).toBeInTheDocument()
  })

  it('has empty words for an order with nothing yet', () => {
    render(
      <OrderBody
        detail={{
          ...detail,
          order: {
            ...detail.order,
            nameservers: null,
            vatPct: null,
            txRef: null,
            customer: undefined,
          },
          lines: { ok: true, data: [] },
          payments: { ok: true, data: [] },
          refunds: { ok: true, data: [] },
          incidents: { ok: true, data: [] },
          activity: { ok: true, data: { domains: new Map(), events: [] } },
        }}
      />,
    )
    expect(screen.getByText('This order has no lines.')).toBeInTheDocument()
    expect(screen.getByText('No payment is recorded for this order.')).toBeInTheDocument()
    expect(screen.getByText('No refunds for this order.')).toBeInTheDocument()
    expect(screen.getByText('No payment incidents for this order.')).toBeInTheDocument()
    expect(screen.getByText('No domain activity since this order was placed.')).toBeInTheDocument()
    expect(screen.getByText('None on the order')).toBeInTheDocument()
    expect(screen.getByText('VAT')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Account 2a2b2c2d' })).toBeInTheDocument()
  })
})

describe('loading', () => {
  it('pulses, hidden from screen readers, rather than spinning', () => {
    const { container, unmount } = render(<OrdersSkeleton />)
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
    expect(container.querySelector('.animate-spin')).toBeNull()
    unmount()
    const order = render(<OrderSkeleton />)
    expect(order.container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })
})
