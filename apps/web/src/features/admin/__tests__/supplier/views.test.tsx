import { render, screen, within } from '@testing-library/react'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BalanceCharts } from '@/features/admin/components/supplier/balance-charts'
import { CallSummary, CallsList, CallsView } from '@/features/admin/components/supplier/calls-view'
import {
  CatalogueControls,
  CatalogueView,
  LastSync,
} from '@/features/admin/components/supplier/catalogue-view'
import {
  ChainStrip,
  LedgerList,
  LedgerView,
} from '@/features/admin/components/supplier/ledger-view'
import { LookupView } from '@/features/admin/components/supplier/lookup-view'
import {
  SupplierHeader,
  SupplierPageSkeleton,
} from '@/features/admin/components/supplier/supplier-header'
import { BalanceSection, SupplierView } from '@/features/admin/components/supplier/supplier-view'
import { TopupsSection } from '@/features/admin/components/supplier/topups-section'
import { parseCallsSearch } from '@/features/admin/lib/supplier-calls'
import { parseLedgerSearch } from '@/features/admin/lib/supplier-ledger'
import { getAttentionCounts } from '@/features/admin/queries/attention'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import * as queries from '@/features/admin/queries/supplier'
import { NOW, supplierFloat, TRACE } from './fixtures'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/admin/supplier/ledger',
}))
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute: vi.fn(), isPending: false, result: {} }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))
vi.mock('@/features/admin/actions/supplier', () => ({
  previewPriceList: vi.fn(),
  previewSslList: vi.fn(),
  applyPriceList: vi.fn(),
  applySslList: vi.fn(),
  recordTopup: vi.fn(),
  correctTopup: vi.fn(),
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({
  readLiveBalance: vi.fn(),
  searchLiveLedger: vi.fn(),
  lookupDomain: vi.fn(),
  readRegistryPage: vi.fn(),
  readRegistrantVerification: vi.fn(),
  readTransferState: vi.fn(),
  checkRenewable: vi.fn(),
  checkSupplierPrice: vi.fn(),
  lookupSsl: vi.fn(),
}))
vi.mock('@/features/admin/queries/session', () => ({
  requireAdmin: vi.fn(),
  getAdminSide: vi.fn(),
}))
vi.mock('@/features/admin/queries/attention', () => ({ getAttentionCounts: vi.fn() }))
vi.mock('@/features/admin/queries/supplier', () => ({
  getSupplierFloat: vi.fn(),
  getLedgerDaily: vi.fn(),
  getBalanceCloses: vi.fn(),
  getLedgerPage: vi.fn(),
  getLedgerRevisions: vi.fn(),
  getLedgerChain: vi.fn(),
  getTopupHistory: vi.fn(),
  getCostingRate: vi.fn(),
  getCalls: vi.fn(),
  getCallSummary: vi.fn(),
  getSyncHeartbeats: vi.fn(),
}))

type Admin = { role: 'owner' | 'operator' | 'viewer'; testOnly: boolean; label: string }
const OWNER: Admin = { role: 'owner', testOnly: false, label: 'owner' }
const TEST_OPERATOR: Admin = { role: 'operator', testOnly: true, label: 'e2e-1' }

function as(admin: Admin, side: 'live' | 'test' = 'live') {
  vi.mocked(requireAdmin).mockResolvedValue(admin as never)
  vi.mocked(getAdminSide).mockResolvedValue(side)
  return admin as never
}

const counts = {
  refunds: 0,
  jobs: 0,
  incidents: 0,
  alertsCritical: 0,
  alertsWarning: 0,
  drift: 0,
  stuckOrders: 0,
  pendingWithoutJob: 0,
  emailsFailed: 0,
  ledgerUnexplained: 2,
  presetDrafts: 0,
}

const ROW: queries.LedgerRow = {
  traceId: TRACE,
  occurredAt: '2026-10-01T09:00:00Z',
  type: 2,
  status: 1,
  chargeType: 1,
  productType: 1,
  description: 'example.com',
  period: 1,
  oldBalanceCents: 4338,
  balanceCents: 3207,
  deltaCents: -1131,
  matchState: 'matched',
  matchCallId: 12,
  matchOperation: 'RegisterWithContactInfo',
  matchOrderItemId: '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
  matchedAt: '2026-10-01T09:05:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(queries.getSupplierFloat).mockResolvedValue(supplierFloat())
  vi.mocked(getAttentionCounts).mockResolvedValue(counts)
})

/** Every element in a tree, depth first. */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  const props = node.props as { children?: ReactNode }
  return [node, ...elements(props.children)]
}

describe('the header', () => {
  it('names the page, with the five pages as tabs and the current one marked', () => {
    render(<SupplierHeader title="Supplier ledger" description="d" side="test" testOnly />)
    const tabs = screen.getByRole('navigation', { name: 'Supplier pages' })
    expect(within(tabs).getAllByRole('link')).toHaveLength(5)
    expect(within(tabs).getByRole('link', { name: 'Ledger' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(tabs).getByRole('link', { name: 'Balance' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Supplier' })).toHaveAttribute(
      'href',
      '/admin/supplier',
    )
  })

  it('has a skeleton, not a spinner, while it loads', () => {
    const { container } = render(<SupplierPageSkeleton cards={2} />)
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3)
  })
})

describe('/admin/supplier', () => {
  it('streams balance, charts and top-ups for the side the admin is on', async () => {
    const admin = as(TEST_OPERATOR, 'test')
    const tree = elements(await SupplierView())
    const props = (type: unknown) =>
      tree.find((element) => element.type === type)?.props as Record<string, unknown>
    expect(props(BalanceSection)).toMatchObject({ side: 'test' })
    expect(props(BalanceCharts)).toMatchObject({ admin, side: 'test' })
    expect(props(TopupsSection)).toMatchObject({ admin, side: 'test' })
  })

  it('shows the balance tiles, the unexplained count linked to the ledger, and the live read', async () => {
    render(await BalanceSection({ side: 'live', now: NOW }))
    const balance = screen.getByRole('region', { name: 'Balance' })
    expect(within(balance).getByText('$43.38')).toBeInTheDocument()
    expect(within(balance).getByRole('link', { name: /Unexplained charges\s+2/ })).toHaveAttribute(
      'href',
      '/admin/supplier/ledger?status=unexplained',
    )
    expect(within(balance).getByRole('button', { name: 'Read live balance' })).toBeEnabled()
    expect(balance).toHaveTextContent('Supplier ledger last read 14:30 WAT.')
  })

  it('leaves the unexplained tile out when the count could not be read, and errs without the float', async () => {
    vi.mocked(getAttentionCounts).mockResolvedValue(null)
    const { unmount } = render(await BalanceSection({ side: 'live', now: NOW }))
    expect(screen.queryByText('Unexplained charges')).toBeNull()
    unmount()
    vi.mocked(queries.getSupplierFloat).mockResolvedValue(null)
    render(await BalanceSection({ side: 'live', now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent("The balance couldn't be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('draws the 90-day close and the ledger’s debits and credits, each with its figures', async () => {
    vi.mocked(queries.getBalanceCloses).mockResolvedValue([{ day: '2026-10-01', closeCents: 738 }])
    vi.mocked(queries.getLedgerDaily).mockResolvedValue([
      { day: '2026-10-02', debitCents: 1131, creditCents: 3600, closeCents: 4338 },
    ])
    render(await BalanceCharts({ admin: as(OWNER), side: 'live', now: NOW }))
    const pictures = screen.getAllByRole('img')
    expect(pictures).toHaveLength(3)
    expect(pictures[0]).toHaveAccessibleName(
      "Supplier balance at each day's close, last 90 days, in US dollars. The figures follow in a table.",
    )
    expect(screen.getByText(/dashed: the alert level, \$20\.00/)).toBeInTheDocument()
    expect(queries.getLedgerDaily).toHaveBeenCalledWith('live', '2026-07-06', '2026-10-03')
  })

  it('says when there is nothing to draw, and errs when a series could not be read', async () => {
    vi.mocked(queries.getBalanceCloses).mockResolvedValue([])
    vi.mocked(queries.getLedgerDaily).mockResolvedValue([])
    vi.mocked(queries.getSupplierFloat).mockResolvedValue(
      supplierFloat({ balanceCents: null, takenAt: null }),
    )
    const { unmount } = render(await BalanceCharts({ admin: as(OWNER), side: 'test', now: NOW }))
    expect(
      screen.getByText('No balance closes on this side in the last 90 days.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('No settled ledger entries on this side in the last 90 days.'),
    ).toBeInTheDocument()
    unmount()
    vi.mocked(queries.getLedgerDaily).mockResolvedValue(null)
    render(await BalanceCharts({ admin: as(OWNER), side: 'test', now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent("The balance charts couldn't be loaded.")
  })
})

describe('top-ups', () => {
  beforeEach(() => {
    vi.mocked(queries.getTopupHistory).mockResolvedValue([
      {
        id: 6,
        traceId: '11111111-2222-3333-4444-555555555555',
        ngnPaidKobo: 2_400_000,
        reference: 'GTB-0041',
        supersedesId: null,
        recordedBy: 'owner',
        recordedAt: '2026-09-25T09:00:00Z',
      },
    ])
    vi.mocked(queries.getCostingRate).mockResolvedValue(1328.1)
  })

  it('lists each credit with what it cost, and offers the owner Record and Correct', async () => {
    render(await TopupsSection({ admin: as(OWNER), side: 'live' }))
    const topups = screen.getByRole('region', { name: 'Top-ups' })
    const table = within(topups).getByRole('table', { name: 'Top-ups, newest first' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      'Date',
      'USD',
      'NGN paid',
      'Effective ₦/$',
      'Reference',
      'Recorded by',
      'Corrected',
      'Action',
    ])
    expect(within(table).getByText('₦24,300')).toBeInTheDocument()
    expect(within(table).getByText('₦1,620.00/$')).toBeInTheDocument()
    expect(within(table).getByText('Record what it cost')).toBeInTheDocument()
    expect(within(table).getByText('Correct')).toBeInTheDocument()
    // The corrected record stays in history, marked.
    expect(within(table).getByText('Yes — 1 earlier record')).toBeInTheDocument()
    expect(within(table).getByText(/GTB-0041/)).toBeInTheDocument()
  })

  it('offers nothing to an operator, and says why', async () => {
    render(await TopupsSection({ admin: as({ ...OWNER, role: 'operator' }), side: 'live' }))
    expect(
      screen.getByText('Only the owner records and corrects what a top-up cost.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Record what it cost')).toBeNull()
  })

  it('records nothing on the test side, and reads no history there', async () => {
    render(await TopupsSection({ admin: as(OWNER, 'test'), side: 'test' }))
    expect(screen.getByText(/recorded on the live side only/)).toBeInTheDocument()
    expect(screen.queryByText('Record what it cost')).toBeNull()
    expect(queries.getTopupHistory).not.toHaveBeenCalled()
  })

  it('says when there are none, and errs when they could not be read', async () => {
    vi.mocked(queries.getSupplierFloat).mockResolvedValue(supplierFloat({ topups: [] }))
    const { unmount } = render(await TopupsSection({ admin: as(OWNER), side: 'live' }))
    expect(screen.getByText('No top-ups on this side yet.')).toBeInTheDocument()
    unmount()
    vi.mocked(queries.getTopupHistory).mockResolvedValue(null)
    render(await TopupsSection({ admin: as(OWNER), side: 'live' }))
    expect(screen.getByRole('alert')).toHaveTextContent("Top-ups couldn't be loaded.")
  })
})

describe('/admin/supplier/ledger', () => {
  it('parses the address and streams the chain and the list; the live search is a form', async () => {
    as(TEST_OPERATOR, 'test')
    const tree = elements(
      await LedgerView({ searchParams: Promise.resolve({ status: 'unexplained', trace: 'x' }) }),
    )
    const list = tree.find((element) => element.type === LedgerList)?.props as {
      params: { status: string[]; trace: string | null }
    }
    expect(list.params.status).toEqual(['unexplained'])
    expect(list.params.trace).toBeNull()
    expect(tree.some((element) => element.type === ChainStrip)).toBe(true)
  })

  it('lists entries with their kind, change, match and revisions; filters as links', async () => {
    vi.mocked(queries.getLedgerPage).mockResolvedValue({ rows: [ROW], total: 30 })
    vi.mocked(queries.getLedgerRevisions).mockResolvedValue(
      new Map([
        [
          TRACE,
          [
            {
              id: 1,
              traceId: TRACE,
              seenAt: '2026-10-02T09:00:00Z',
              changes: { status: { stored: 0, read: 1 } },
              applied: true,
            },
          ],
        ],
      ]),
    )
    const params = parseLedgerSearch({ status: 'matched', per: '25' })
    render(await LedgerList({ admin: as(OWNER), side: 'live', params }))
    const table = screen.getByRole('table', { name: 'Supplier ledger entries' })
    expect(within(table).getByText('Domain charge')).toBeInTheDocument()
    expect(within(table).getByText('−$11.31')).toBeInTheDocument()
    expect(within(table).getByText('Matched to a registration')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Open the order line' })).toHaveAttribute(
      'href',
      '/admin/orders?line=0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
    )
    expect(within(table).getByText('1 revision')).toBeInTheDocument()
    expect(within(table).getByText('status: 0 → 1')).toBeInTheDocument()
    const match = screen.getByRole('navigation', { name: 'Match' })
    expect(within(match).getByRole('link', { name: 'Matched' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(match).getByRole('link', { name: 'No matching order' })).toHaveAttribute(
      'href',
      '/admin/supplier/ledger?status=matched%2Cunexplained',
    )
    expect(screen.getByText('Page 1 of 2 · 30 in all')).toBeInTheDocument()
  })

  it('offers to clear filters that match nothing, and says when the mirror is empty', async () => {
    vi.mocked(queries.getLedgerPage).mockResolvedValue({ rows: [], total: 0 })
    vi.mocked(queries.getLedgerRevisions).mockResolvedValue(new Map())
    const { unmount } = render(
      await LedgerList({
        admin: as(OWNER),
        side: 'live',
        params: parseLedgerSearch({ trace: TRACE }),
      }),
    )
    expect(screen.getByText('No entries match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear the filters' })).toHaveAttribute(
      'href',
      '/admin/supplier/ledger',
    )
    expect(screen.getByRole('link', { name: 'Show every entry' })).toHaveAttribute(
      'href',
      '/admin/supplier/ledger',
    )
    unmount()
    render(await LedgerList({ admin: as(OWNER), side: 'live', params: parseLedgerSearch({}) }))
    expect(screen.getByText('No ledger entries on this side yet.')).toBeInTheDocument()
  })

  it('errs when the list could not be read', async () => {
    vi.mocked(queries.getLedgerPage).mockResolvedValue(null)
    render(await LedgerList({ admin: as(OWNER), side: 'live', params: parseLedgerSearch({}) }))
    expect(screen.getByRole('alert')).toHaveTextContent("The ledger couldn't be loaded.")
  })

  it('shows the balance chain agreeing, or each break with a link to its entry', async () => {
    const entry = (traceId: string, minute: number, from: number, to: number) => ({
      traceId,
      occurredAt: new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString(),
      description: 'x.com',
      oldBalanceCents: from,
      balanceCents: to,
    })
    vi.mocked(queries.getLedgerChain).mockResolvedValue([
      entry('a', 0, 0, 1500),
      entry('b', 1, 1500, 369),
    ])
    const { unmount } = render(await ChainStrip({ admin: as(OWNER), side: 'live' }))
    const chain = screen.getByRole('region', { name: /Balance chain/ })
    expect(chain).toHaveTextContent('Agrees')
    expect(chain).toHaveTextContent('0.00 → 15.00 → 3.69')
    unmount()

    vi.mocked(queries.getLedgerChain).mockResolvedValue([
      entry('a', 0, 0, 1500),
      entry('b', 1, 1400, 369),
    ])
    const second = render(await ChainStrip({ admin: as(OWNER), side: 'live' }))
    expect(screen.getByText('1 break')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open this entry' })).toHaveAttribute(
      'href',
      '/admin/supplier/ledger?trace=b',
    )
    second.unmount()

    vi.mocked(queries.getLedgerChain).mockResolvedValue([])
    const third = render(await ChainStrip({ admin: as(OWNER), side: 'live' }))
    expect(screen.getByText(/No ledger entries on this side yet/)).toBeInTheDocument()
    third.unmount()

    vi.mocked(queries.getLedgerChain).mockResolvedValue(null)
    render(await ChainStrip({ admin: as(OWNER), side: 'live' }))
    expect(screen.getByRole('alert')).toHaveTextContent("The balance chain couldn't be checked.")
  })
})

describe('/admin/supplier/calls', () => {
  it('parses the address and streams the summary and the list', async () => {
    as(OWNER, 'test')
    const tree = elements(await CallsView({ searchParams: Promise.resolve({ status: 'unknown' }) }))
    const list = tree.find((element) => element.type === CallsList)?.props as {
      side: string
      params: { status: string[] }
    }
    expect(list).toMatchObject({ side: 'test', params: { status: ['unknown'] } })
    expect(tree.some((element) => element.type === CallSummary)).toBe(true)
  })

  it('summarises by operation over the last 7 days, or the range asked', async () => {
    vi.mocked(queries.getCallSummary).mockResolvedValue([
      { operation: 'GetList', outcome: 'ok', count: 219, p50Ms: 800, p95Ms: 2100 },
    ])
    const { unmount } = render(
      await CallSummary({ side: 'live', params: parseCallsSearch({}), now: NOW }),
    )
    expect(queries.getCallSummary).toHaveBeenCalledWith('live', '2026-09-27', '2026-10-03')
    const table = screen.getByRole('table', { name: 'Supplier calls by operation and outcome' })
    expect(within(table).getByText('Read the listing')).toBeInTheDocument()
    expect(within(table).getByText('2.1 s')).toBeInTheDocument()
    unmount()

    vi.mocked(queries.getCallSummary).mockResolvedValue([])
    const second = render(
      await CallSummary({
        side: 'live',
        params: parseCallsSearch({ from: '2026-10-01', to: '2026-10-01' }),
        now: NOW,
      }),
    )
    expect(screen.getByText('No calls recorded in this range.')).toBeInTheDocument()
    expect(screen.getByText(/On 2026-10-01/)).toBeInTheDocument()
    second.unmount()

    vi.mocked(queries.getCallSummary).mockResolvedValue(null)
    render(await CallSummary({ side: 'live', params: parseCallsSearch({}), now: NOW }))
    expect(screen.getByRole('alert')).toHaveTextContent("The calls summary couldn't be loaded.")
  })

  it('lists each call with its outcome, code, time and job', async () => {
    vi.mocked(queries.getCalls).mockResolvedValue({
      rows: [
        {
          id: 1,
          createdAt: '2026-10-01T09:00:00Z',
          operation: 'RegisterWithContactInfo',
          outcome: 'unknown',
          domainName: 'example.com',
          errorCode: 'TIMEOUT',
          httpStatus: null,
          durationMs: 12_000,
          jobId: '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
          sslJobId: null,
        },
        {
          id: 2,
          createdAt: '2026-10-01T09:00:00Z',
          operation: 'SslInitialize',
          outcome: 'odd',
          domainName: null,
          errorCode: null,
          httpStatus: null,
          durationMs: 300,
          jobId: null,
          sslJobId: '1b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
        },
      ],
      total: 2,
    })
    render(
      await CallsList({
        admin: as(OWNER),
        side: 'live',
        params: parseCallsSearch({ job: '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e' }),
      }),
    )
    const table = screen.getByRole('table', { name: 'Supplier calls' })
    expect(within(table).getByText('Unknown outcome')).toBeInTheDocument()
    expect(within(table).getByText('TIMEOUT')).toBeInTheDocument()
    expect(within(table).getByText('12.0 s')).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Open the job' })).toHaveAttribute(
      'href',
      '/admin/queue/jobs/0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
    )
    expect(within(table).getByRole('link', { name: 'Open the certificate job' })).toHaveAttribute(
      'href',
      '/admin/queue/ssl-jobs/1b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
    )
    expect(screen.getByRole('link', { name: 'Show every call' })).toHaveAttribute(
      'href',
      '/admin/supplier/calls',
    )
    expect(screen.getByRole('combobox', { name: 'Operation' })).toBeInTheDocument()
  })

  it('says when there are none, filtered or not, and errs when unread', async () => {
    vi.mocked(queries.getCalls).mockResolvedValue({ rows: [], total: 0 })
    const { unmount } = render(
      await CallsList({ admin: as(OWNER), side: 'live', params: parseCallsSearch({}) }),
    )
    expect(screen.getByText('No calls recorded on this side yet.')).toBeInTheDocument()
    unmount()
    const second = render(
      await CallsList({
        admin: as(OWNER),
        side: 'live',
        params: parseCallsSearch({ status: 'blocked' }),
      }),
    )
    expect(screen.getByText('No calls match these filters.')).toBeInTheDocument()
    second.unmount()
    vi.mocked(queries.getCalls).mockResolvedValue(null)
    render(await CallsList({ admin: as(OWNER), side: 'live', params: parseCallsSearch({}) }))
    expect(screen.getByRole('alert')).toHaveTextContent("The calls couldn't be loaded.")
  })
})

describe('/admin/supplier/lookup', () => {
  it('offers an operator every read, and a test administrator no price check', async () => {
    as({ ...OWNER, role: 'operator' })
    const { unmount } = render(await LookupView())
    expect(screen.getByRole('button', { name: 'Check the price' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check renewability' })).toBeInTheDocument()
    unmount()

    as(TEST_OPERATOR, 'test')
    render(await LookupView())
    const price = screen.getByRole('region', { name: 'A price' })
    expect(price).toHaveTextContent("Test administrators can't do this on live records.")
    expect(within(price).queryByRole('button')).toBeNull()
    expect(screen.getByRole('button', { name: 'Read the transfer state' })).toBeInTheDocument()
  })

  it('tells a viewer their role cannot read a domain', async () => {
    as({ ...OWNER, role: 'viewer' })
    render(await LookupView())
    expect(screen.getAllByText("Your admin role can't do this. Ask the owner.")).toHaveLength(4)
  })
})

describe('/admin/supplier/catalogue', () => {
  it('gives each list its last sync and its controls, for the admin looking', async () => {
    const admin = as(OWNER)
    const tree = elements(await CatalogueView())
    const of = (type: unknown) =>
      tree.filter((element) => element.type === type).map((element) => element.props)
    expect(of(LastSync)).toEqual([
      { admin, kind: 'tlds' },
      { admin, kind: 'ssl' },
    ])
    expect(of(CatalogueControls)).toEqual([
      { admin, kind: 'tlds' },
      { admin, kind: 'ssl' },
    ])
  })

  it('offers the owner a preview and an apply for each list', () => {
    for (const kind of ['tlds', 'ssl'] as const) {
      const { unmount } = render(<CatalogueControls admin={as(OWNER)} kind={kind} />)
      expect(screen.getByRole('button', { name: 'Preview changes' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Apply / })).toBeInTheDocument()
      unmount()
    }
  })

  it('gives an operator the owner-only words, and a test administrator SQL’s', () => {
    const { unmount } = render(
      <CatalogueControls admin={as({ ...OWNER, role: 'operator' })} kind="tlds" />,
    )
    expect(
      screen.getByText('Only the owner previews and applies the price list.'),
    ).toBeInTheDocument()
    unmount()
    render(<CatalogueControls admin={as(TEST_OPERATOR, 'test')} kind="ssl" />)
    expect(
      screen.getByText("Test administrators can't do this on live records."),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview changes' })).toBeNull()
  })

  it('says when each weekly sync last ran', async () => {
    vi.mocked(queries.getSyncHeartbeats).mockResolvedValue({
      tlds: { beatAt: '2026-10-01T12:03:10Z', outcome: 'written', changes: 3 },
      ssl: null,
    })
    const { unmount } = render(await LastSync({ admin: as(OWNER), kind: 'tlds' }))
    expect(
      screen.getByText('Last sync 1 Oct 2026, 13:03 WAT: wrote its changes (3 changes).'),
    ).toBeInTheDocument()
    unmount()
    const ssl = render(await LastSync({ admin: as(OWNER), kind: 'ssl' }))
    expect(
      screen.getByText('The weekly sync has not run from the gateway yet.'),
    ).toBeInTheDocument()
    ssl.unmount()
    vi.mocked(queries.getSyncHeartbeats).mockResolvedValue('hidden')
    const hidden = render(await LastSync({ admin: as(TEST_OPERATOR), kind: 'ssl' }))
    expect(screen.getByText(/not shown to test administrators/)).toBeInTheDocument()
    hidden.unmount()
    vi.mocked(queries.getSyncHeartbeats).mockResolvedValue(null)
    render(await LastSync({ admin: as(OWNER), kind: 'ssl' }))
    expect(screen.getByText(/couldn’t be read/)).toBeInTheDocument()
  })
})
