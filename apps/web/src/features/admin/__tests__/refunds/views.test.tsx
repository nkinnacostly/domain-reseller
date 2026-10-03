import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IncidentsView } from '@/features/admin/components/refunds/incidents-view'
import { RefundView } from '@/features/admin/components/refunds/refund-view'
import { RefundsView } from '@/features/admin/components/refunds/refunds-view'
import {
  countOpenIncidents,
  getRefund,
  getRefundStats,
  type IncidentRow,
  listIncidents,
  listRefunds,
  type RefundDetail,
  type RefundRow,
  type RefundStats,
} from '@/features/admin/queries/refunds'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'

/**
 * The three refunds pages (ADMIN-SPEC §5.2 B3, S11): each shows success,
 * empty and error states, and the buttons its admin's role allows — Cancel
 * for the owner alone. Reads are mocked here; queries.test.ts covers them.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/refunds',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/components/shell/side-switch', () => ({
  SideSwitch: ({ side }: { side: string }) => <p>Side: {side}</p>,
}))
vi.mock('@/features/admin/queries/session', () => ({
  requireAdmin: vi.fn(),
  getAdminSide: vi.fn(),
}))
vi.mock('@/features/admin/queries/refunds', () => ({
  getRefundStats: vi.fn(),
  listRefunds: vi.fn(),
  getRefund: vi.fn(),
  listIncidents: vi.fn(),
  countOpenIncidents: vi.fn(),
}))
vi.mock('@/features/admin/actions/refunds', () => ({
  approveRefund: vi.fn(),
  retryRefund: vi.fn(),
  cancelRefund: vi.fn(),
  recordManualRefund: vi.fn(),
}))
vi.mock('@/features/admin/actions/incidents', () => ({
  resolveIncident: vi.fn(),
  resolveMoneyIncident: vi.fn(),
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({ checkFlutterwaveRefund: vi.fn() }))

const REFUND = '6f1d2c3b-4a59-4687-9a1b-2c3d4e5f6a7b'
const ORDER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const STATS: RefundStats = {
  byReasonStatus: [
    { reason: 'registration_failed', status: 'held', count: 2, amountKobo: 215_000 },
    { reason: 'overpayment', status: 'failed', count: 1, amountKobo: 5_000 },
    { reason: 'overpayment', status: 'completed', count: 4, amountKobo: 20_000 },
  ],
  openOldestAt: '2026-10-01T09:00:00Z',
  medianHoursToComplete: 1.5,
  sent24hKobo: 4_321_050,
  limits: { singleKobo: 12_345_600, dailyKobo: 98_765_400, delayMinutes: 17 },
}

const ROW: RefundRow = {
  id: REFUND,
  createdAt: '2026-10-02T10:00:00Z',
  updatedAt: '2026-10-02T11:00:00Z',
  orderId: ORDER,
  orderNumber: 'ND-001234',
  reason: 'registration_failed',
  status: 'held',
  amountKobo: 107_500,
  lastErrorCode: 'OVER_SINGLE_LIMIT',
  attempts: 0,
  testMode: true,
}

const DETAIL: RefundDetail = {
  id: REFUND,
  createdAt: '2026-10-02T10:00:00Z',
  updatedAt: '2026-10-02T11:00:00Z',
  reason: 'registration_failed',
  status: 'held',
  amountKobo: 107_500,
  lastErrorCode: 'OVER_SINGLE_LIMIT',
  attempts: 0,
  runAfter: '2026-10-02T10:10:00Z',
  approvedAt: null,
  approvedBy: null,
  completedAt: null,
  submittedAt: null,
  providerCalledAt: null,
  providerRefundId: null,
  providerStatus: null,
  failedProviderRefundIds: [],
  paymentId: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  testMode: true,
  order: {
    id: ORDER,
    orderNumber: 'ND-001234',
    status: 'partially_failed',
    totalKobo: 215_000,
    paidAt: '2026-10-02T09:59:00Z',
    txRef: 'MDH-abc',
  },
  line: {
    id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
    domain: 'example.com',
    itemType: 'register',
    status: 'failed',
    priceKobo: 100_000,
    periodYears: 1,
  },
  events: [
    {
      id: 2,
      at: '2026-10-02T10:00:01Z',
      event: 'held',
      actor: 'system',
      detail: { why: 'over_single_limit' },
    },
  ],
}

const INCIDENT: IncidentRow = {
  id: 42,
  createdAt: '2026-10-02T10:00:00Z',
  kind: 'unrecorded_payment',
  orderId: ORDER,
  orderNumber: 'ND-001234',
  providerReference: '456',
  detail: { amount_kobo: 107_500, currency: 'NGN', nested: { a: 1 } },
  resolvedAt: null,
  resolvedBy: null,
  testMode: true,
  completedRefunds: [],
}

function as(role: 'owner' | 'operator' | 'viewer', testOnly = false) {
  vi.mocked(requireAdmin).mockResolvedValue({ role, testOnly, label: role } as never)
  vi.mocked(getAdminSide).mockResolvedValue(testOnly ? 'test' : 'live')
}

beforeEach(() => {
  vi.clearAllMocks()
  as('operator', true)
  vi.mocked(getRefundStats).mockResolvedValue(STATS)
  vi.mocked(countOpenIncidents).mockResolvedValue(1)
})

describe('/admin/refunds', () => {
  it('shows the figures from SQL, the filters with counts, and the refunds', async () => {
    vi.mocked(listRefunds).mockResolvedValue({ ok: true, rows: [ROW], total: 1 })
    render(await RefundsView({ searchParams: Promise.resolve({ status: 'held' }) }))
    expect(screen.getByRole('heading', { level: 1, name: 'Refunds' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Need a person/ })).toHaveTextContent('3')
    expect(screen.getByText('₦43,210.50')).toBeInTheDocument()
    expect(screen.getByText('₦123,456')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Payment incidents (1)' })).toBeInTheDocument()
    const status = screen.getByRole('navigation', { name: 'Status' })
    expect(within(status).getByRole('link', { name: 'Held for approval (2)' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    const table = screen.getByRole('table', { name: 'Refunds, Test side' })
    expect(within(table).getByRole('link', { name: 'Refund for ND-001234' })).toHaveAttribute(
      'href',
      `/admin/refunds/${REFUND}`,
    )
    expect(within(table).getByText('₦1,075')).toBeInTheDocument()
    expect(listRefunds).toHaveBeenCalledWith(
      expect.anything(),
      'test',
      expect.objectContaining({ status: ['held'], reasons: [], orderNumber: null }),
    )
  })

  it('says when nothing matches, and offers every refund', async () => {
    vi.mocked(listRefunds).mockResolvedValue({ ok: true, rows: [], total: 0 })
    render(await RefundsView({ searchParams: Promise.resolve({ reason: 'overpayment' }) }))
    expect(screen.getByText('No refunds match these filters')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show every refund' })).toHaveAttribute(
      'href',
      '/admin/refunds',
    )
  })

  it('says the side is empty when nothing is filtered', async () => {
    vi.mocked(listRefunds).mockResolvedValue({ ok: true, rows: [], total: 0 })
    render(await RefundsView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText('No refunds on the Test side yet')).toBeInTheDocument()
  })

  it('takes an order number as a search, and nothing else', async () => {
    render(await RefundsView({ searchParams: Promise.resolve({ q: 'someone@example.com' }) }))
    expect(screen.getByRole('status')).toHaveTextContent('Search by order number only')
    expect(listRefunds).not.toHaveBeenCalled()

    vi.mocked(listRefunds).mockResolvedValue({ ok: true, rows: [], total: 0 })
    render(await RefundsView({ searchParams: Promise.resolve({ q: '1234' }) }))
    expect(listRefunds).toHaveBeenCalledWith(
      expect.anything(),
      'test',
      expect.objectContaining({ orderNumber: 'ND-001234' }),
    )
  })

  it('shows each failure with a way on', async () => {
    vi.mocked(getRefundStats).mockResolvedValue(null)
    vi.mocked(countOpenIncidents).mockResolvedValue(null)
    vi.mocked(listRefunds).mockResolvedValue({ ok: false })
    render(await RefundsView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText("The refund figures couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByText("The refunds couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Payment incidents' })).toBeInTheDocument()
  })
})

describe('/admin/refunds/[id]', () => {
  const view = async (id = REFUND) => render(await RefundView({ params: Promise.resolve({ id }) }))

  it('shows a held refund with its playbook, limits, payment and timeline, and Approve for an operator', async () => {
    vi.mocked(getRefund).mockResolvedValue({ ok: true, refund: DETAIL })
    await view()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Refund for ND-001234' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/The refund is above the automatic limit for one refund/),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Held because: Over the ₦123,456 automatic limit per refund.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve refund' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel refund' })).not.toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText('MDH-abc')).toBeInTheDocument()
    // The status pill, the summary and the timeline's first event.
    expect(screen.getAllByText('Held for approval').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByRole('link', { name: 'ND-001234' })).toHaveAttribute(
      'href',
      `/admin/orders/${ORDER}`,
    )
    expect(
      screen.queryByRole('region', { name: 'Record a Flutterwave refund' }),
    ).not.toBeInTheDocument()
  })

  it('shows Cancel to the owner', async () => {
    as('owner')
    vi.mocked(getRefund).mockResolvedValue({ ok: true, refund: DETAIL })
    await view()
    expect(screen.getByRole('button', { name: 'Cancel refund' })).toBeInTheDocument()
  })

  it('offers the record step when the playbook does', async () => {
    vi.mocked(getRefund).mockResolvedValue({
      ok: true,
      refund: {
        ...DETAIL,
        status: 'needs_attention',
        lastErrorCode: 'REFUND_OUTCOME_UNKNOWN',
        providerCalledAt: '2026-10-02T10:20:00Z',
        failedProviderRefundIds: ['r-0'],
      },
    })
    await view()
    expect(screen.getByRole('region', { name: 'Record a Flutterwave refund' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry refund' })).toBeInTheDocument()
    expect(screen.getByText('r-0')).toBeInTheDocument()
  })

  it('points an operator at the record step when that is all the playbook offers', async () => {
    vi.mocked(getRefund).mockResolvedValue({
      ok: true,
      refund: {
        ...DETAIL,
        status: 'failed',
        lastErrorCode: 'AMOUNT_MISMATCH',
        providerRefundId: 'r-1',
      },
    })
    await view()
    expect(
      screen.getByText('Check the Flutterwave refund below, then record it.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Record a Flutterwave refund' })).toBeInTheDocument()
  })

  it('offers nothing without the limits, and says why', async () => {
    vi.mocked(getRefundStats).mockResolvedValue(null)
    vi.mocked(getRefund).mockResolvedValue({ ok: true, refund: DETAIL })
    await view()
    expect(screen.getByText("The automatic limits couldn't be read.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve refund' })).not.toBeInTheDocument()
  })

  it.each([
    ['completed', null, 'This refund is done: the money went back.'],
    ['submitted', null, 'This refund is with the worker or Flutterwave.'],
    ['queued', null, 'This refund is queued'],
    ['cancelled', 'CHARGE_NOT_OURS', 'Only the owner can retry or record it.'],
    ['failed', 'SOMETHING_NEW', 'The playbook offers no button for this code.'],
  ])('says why a %s refund has no button', async (status, code, words) => {
    vi.mocked(getRefund).mockResolvedValue({
      ok: true,
      refund: { ...DETAIL, status, lastErrorCode: code },
    })
    await view()
    expect(screen.getByText(new RegExp(words.replace(/[.?]/g, '\\$&')))).toBeInTheDocument()
  })

  it('tells a viewer the role only reads', async () => {
    as('viewer')
    vi.mocked(getRefund).mockResolvedValue({ ok: true, refund: DETAIL })
    await view()
    expect(screen.getByText('Your admin role can view refunds only.')).toBeInTheDocument()
  })

  it('says a refund is not on this side, and how to get back', async () => {
    vi.mocked(getRefund).mockResolvedValue({ ok: true, refund: null })
    await view('nope')
    expect(screen.getByText('No refund with this id on the Test side')).toBeInTheDocument()
    expect(screen.getByText('Test administrators see test-mode refunds only.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to refunds' })).toHaveAttribute(
      'href',
      '/admin/refunds',
    )
  })

  it('shows a failed read with a way on', async () => {
    vi.mocked(getRefund).mockResolvedValue({ ok: false })
    await view()
    expect(screen.getByText("This refund couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('/admin/refunds/incidents', () => {
  const view = async (search: Record<string, string> = {}) =>
    render(await IncidentsView({ searchParams: Promise.resolve(search) }))

  it('lists open incidents with what they mean and a way to resolve them', async () => {
    vi.mocked(listIncidents).mockResolvedValue({ ok: true, rows: [INCIDENT], total: 1 })
    await view()
    expect(screen.getByRole('heading', { level: 1, name: 'Payment incidents' })).toBeInTheDocument()
    const card = screen
      .getByRole('list', { name: 'Payment incidents, Test side' })
      .querySelector('#incident-42') as HTMLElement
    expect(card).not.toBeNull()
    expect(within(card).getByRole('heading', { name: 'Payment not recorded' })).toBeInTheDocument()
    expect(within(card).getByText('Money owed')).toBeInTheDocument()
    expect(within(card).getByText('₦1,075')).toBeInTheDocument()
    expect(within(card).getByRole('group', { name: 'What happened?' })).toBeInTheDocument()
    expect(within(card).queryByRole('radio', { name: /Handled outside/ })).not.toBeInTheDocument()
  })

  it('tells a viewer the role only reads, and shows resolved ones without a button', async () => {
    as('viewer')
    vi.mocked(listIncidents).mockResolvedValue({
      ok: true,
      rows: [
        INCIDENT,
        {
          ...INCIDENT,
          id: 43,
          kind: 'underpayment',
          resolvedAt: '2026-10-02T12:00:00Z',
          resolvedBy: 'owner',
        },
      ],
      total: 2,
    })
    await view({ state: 'all' })
    expect(screen.getByText(/Your admin role can view incidents only/)).toBeInTheDocument()
    expect(screen.getByText(/by owner/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark resolved' })).not.toBeInTheDocument()
  })

  it('says when there is nothing open, or nothing matches', async () => {
    vi.mocked(listIncidents).mockResolvedValue({ ok: true, rows: [], total: 0 })
    await view()
    expect(screen.getByText('No open payment incidents on the Test side')).toBeInTheDocument()
    await view({ kind: 'underpayment' })
    expect(screen.getByText('No incidents match these filters')).toBeInTheDocument()
  })

  it('shows a failed read with a way on', async () => {
    vi.mocked(listIncidents).mockResolvedValue({ ok: false })
    await view()
    expect(screen.getByText("The payment incidents couldn't be loaded.")).toBeInTheDocument()
  })
})
