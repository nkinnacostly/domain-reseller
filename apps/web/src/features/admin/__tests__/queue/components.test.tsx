import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { failJob, failSslJob, retryJob, retrySslJob } from '@/features/admin/actions/jobs'
import {
  checkRenewable,
  lookupDomain,
  readTransferState,
} from '@/features/admin/actions/supplier-live'
import { JobActions } from '@/features/admin/components/queue/job-actions'
import { JobDetailBody, JobNotFound } from '@/features/admin/components/queue/job-detail'
import { JobsTable, SslJobsTable } from '@/features/admin/components/queue/jobs-list'
import { LiveRead } from '@/features/admin/components/queue/live-read'
import { PENDING_NOTE, PendingTable } from '@/features/admin/components/queue/pending-list'
import { QueueHeader } from '@/features/admin/components/queue/queue-header'
import { byKind, QueueStatsPanel } from '@/features/admin/components/queue/queue-stats'
import { SslJobDetailBody } from '@/features/admin/components/queue/ssl-job-detail'
import { ADMIN_ERROR_WORDS, LOST_ANSWER_WORDS } from '@/features/admin/lib/errors'
import { ONLY_RETRY_WORDS } from '@/features/admin/lib/jobs-copy'
import { parseListParams } from '@/features/admin/lib/list-params'
import { JOB_LIST_SPEC } from '@/features/admin/lib/queue-facts'
import type { JobDetail, JobRow, SslJobDetail } from '@/features/admin/queries/queue'

const refresh = vi.fn()
let pathname = '/admin/queue'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => pathname,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/components/shell/side-switch', () => ({
  SideSwitch: ({ side }: { side: string }) => <p>Side: {side}</p>,
}))
vi.mock('@/features/admin/actions/jobs', () => ({
  retryJob: vi.fn(),
  failJob: vi.fn(),
  retrySslJob: vi.fn(),
  failSslJob: vi.fn(),
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({
  lookupDomain: vi.fn(),
  readTransferState: vi.fn(),
  checkRenewable: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  pathname = '/admin/queue'
})

const JOB = '3c9e6b1a-1d2f-4e5a-8b7c-6d5e4f3a2b1c'
const DOMAIN = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const LINE = '9f8e7d6c-5b4a-4321-8fed-cba987654321'
const ORDER = '1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b'
const NOW = new Date('2026-10-03T12:00:00Z')

const operator = { role: 'operator' as const, testOnly: true }
const viewer = { role: 'viewer' as const, testOnly: false }

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB,
    kind: 'register_domain',
    status: 'failed',
    attempts: 2,
    lastErrorCode: 'DOMAIN_TAKEN',
    runAfter: '2026-10-03T10:00:00Z',
    createdAt: '2026-10-03T09:00:00Z',
    updatedAt: '2026-10-03T10:00:00Z',
    testMode: true,
    domainId: DOMAIN,
    domainName: 'example.com',
    ...overrides,
  }
}

function detail(
  job: Partial<JobDetail['job']> = {},
  rest: Partial<Omit<JobDetail, 'job'>> = {},
): JobDetail {
  return {
    job: {
      id: JOB,
      kind: 'register_domain',
      status: 'failed',
      attempts: 2,
      lastErrorCode: 'DOMAIN_TAKEN',
      runAfter: '2026-10-03T10:00:00Z',
      createdAt: '2026-10-03T09:00:00Z',
      updatedAt: '2026-10-03T10:00:00Z',
      finishedAt: '2026-10-03T10:00:00Z',
      submittedAt: null,
      baselineExpiry: null,
      lockedAt: null,
      lockedBy: null,
      testMode: true,
      domainId: DOMAIN,
      orderItemId: LINE,
      ...job,
    },
    domain: {
      id: DOMAIN,
      name: 'example.com',
      localStatus: 'registration_failed',
      expiresAt: null,
      transferLock: null,
      privacyEnabled: false,
      pendingTransferLock: null,
      pendingPrivacy: null,
      source: 'registration',
    },
    line: {
      id: LINE,
      orderId: ORDER,
      orderNumber: 'MDH-1001',
      itemType: 'register',
      domain: 'example.com',
      periodYears: 1,
      renewalYears: 1,
      priceKobo: 100_000,
      renewalKobo: 100_000,
      status: 'failed',
      failureCode: 'DOMAIN_TAKEN',
    },
    orderLines: [{ id: LINE, priceKobo: 100_000, createdAt: '2026-10-03T08:00:00Z' }],
    order: { subtotalKobo: 100_000, vatKobo: 7_500 },
    refunds: [
      {
        id: ORDER,
        status: 'queued',
        amountKobo: 107_500,
        providerRefundId: null,
        reason: 'registration_failed',
        lastErrorCode: null,
        createdAt: '2026-10-03T10:00:00Z',
        updatedAt: '2026-10-03T10:00:00Z',
      },
    ],
    calls: [
      {
        id: 2,
        createdAt: '2026-10-03T09:59:00Z',
        operation: 'RegisterWithContactInfo',
        outcome: 'refused',
        errorCode: 'DOMAIN_TAKEN',
        httpStatus: 403,
        durationMs: 1200,
      },
    ],
    registryRead: null,
    transferRead: null,
    lastAttemptAt: '2026-10-03T09:59:00Z',
    events: [
      {
        id: 9,
        eventType: 'registration_failed',
        actorType: 'system',
        createdAt: '2026-10-03T10:00:00Z',
      },
      { id: 8, eventType: 'order_paid', actorType: 'customer', createdAt: '2026-10-03T09:00:00Z' },
    ],
    ...rest,
  }
}

describe('QueueHeader', () => {
  it('marks the open list in the tabs (S13)', () => {
    pathname = '/admin/queue/pending'
    render(<QueueHeader side="test" testOnly />)
    const tabs = screen.getByRole('navigation', { name: 'Queue lists' })
    expect(within(tabs).getByRole('link', { name: 'Paid, no job' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(tabs).getByRole('link', { name: 'Jobs' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('heading', { level: 1, name: 'Queue' })).toBeInTheDocument()
    expect(screen.getByText('Side: test')).toBeInTheDocument()
  })
})

describe('JobsTable', () => {
  const params = parseListParams({ status: 'failed' }, JOB_LIST_SPEC)

  it('links each job by id, shows its words, and sorts by link (aria-sort)', () => {
    render(
      <JobsTable
        rows={[row(), row({ id: LINE, status: 'queued', domainName: null, lastErrorCode: null })]}
        total={2}
        params={params}
        filters={{ kind: null, domainId: null }}
        kinds={['register_domain', 'set_privacy']}
      />,
    )
    const table = screen.getByRole('table', { name: 'Jobs, newest first unless sorted' })
    const link = within(table).getByRole('link', { name: /Registration\s*example\.com/ })
    expect(link).toHaveAttribute('href', `/admin/queue/jobs/${JOB}`)
    expect(within(table).getByRole('link', { name: /Domain 7a1b2c3d/ })).toBeInTheDocument()
    expect(within(table).getAllByText('Failed').length).toBeGreaterThan(0)
    expect(within(table).getByText('DOMAIN_TAKEN')).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: /Made/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(
      within(screen.getByRole('navigation', { name: 'Status' })).getByRole('link', {
        name: 'Failed',
      }),
    ).toHaveAttribute('aria-current', 'true')
    expect(
      within(screen.getByRole('navigation', { name: 'Kind' })).getByRole('link', {
        name: 'Privacy change',
      }),
    ).toHaveAttribute('href', '/admin/queue?status=failed&kind=set_privacy')
    expect(screen.getByRole('form', { name: 'Created between' })).toBeInTheDocument()
    expect(screen.getByText('2 in all')).toBeInTheDocument()
  })

  it('says when nothing matches the filters, and links back to all jobs', () => {
    render(
      <JobsTable
        rows={[]}
        total={0}
        params={parseListParams({ status: 'failed', from: '2026-10-01' }, JOB_LIST_SPEC)}
        filters={{ kind: 'set_privacy', domainId: DOMAIN }}
        kinds={['register_domain']}
      />,
    )
    expect(screen.getByText('No jobs match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear the filters' })).toHaveAttribute(
      'href',
      '/admin/queue',
    )
    expect(screen.getByText(/One domain's jobs only/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Any date' })).toHaveAttribute(
      'href',
      `/admin/queue?status=failed&kind=set_privacy&domain=${DOMAIN}`,
    )
  })

  it('says when this side has no jobs at all', () => {
    render(
      <JobsTable
        rows={[]}
        total={0}
        params={parseListParams({}, JOB_LIST_SPEC)}
        filters={{ kind: null, domainId: null }}
        kinds={[]}
      />,
    )
    expect(screen.getByText('No jobs on this side yet.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Any date' })).toBeNull()
  })
})

describe('SslJobsTable', () => {
  it('lists certificate jobs with whether each was sent', () => {
    render(
      <SslJobsTable
        rows={[
          {
            id: JOB,
            kind: 'ssl_initialize',
            status: 'needs_attention',
            attempts: 1,
            lastErrorCode: null,
            runAfter: '2026-10-03T10:00:00Z',
            sentAt: null,
            createdAt: '2026-10-03T09:00:00Z',
            updatedAt: '2026-10-03T10:00:00Z',
            testMode: false,
            certificateId: DOMAIN,
          },
        ]}
        total={1}
        params={parseListParams({}, JOB_LIST_SPEC)}
        filters={{ kind: null, domainId: null }}
        kinds={['ssl_initialize']}
      />,
    )
    const table = screen.getByRole('table', {
      name: 'Certificate jobs, newest first unless sorted',
    })
    expect(
      within(table).getByRole('link', { name: /Certificate order\s*Certificate 7a1b2c3d/ }),
    ).toHaveAttribute('href', `/admin/queue/ssl-jobs/${JOB}`)
    expect(within(table).getByText('Not sent')).toBeInTheDocument()
  })

  it('says when there are none', () => {
    render(
      <SslJobsTable
        rows={[]}
        total={0}
        params={parseListParams({}, JOB_LIST_SPEC)}
        filters={{ kind: null, domainId: null }}
        kinds={[]}
      />,
    )
    expect(screen.getByText('No certificate jobs on this side yet.')).toBeInTheDocument()
  })
})

describe('PendingTable', () => {
  it('keeps the note, links each line to its order, and counts certificate lines', () => {
    render(
      <PendingTable
        report={{
          rows: [
            {
              id: LINE,
              orderId: ORDER,
              orderNumber: 'MDH-1001',
              domain: 'example.com',
              itemType: 'renew',
              status: 'pending',
              paidAt: '2026-10-03T11:00:00Z',
            },
          ],
          certificateLines: 2,
        }}
        now={NOW}
      />,
    )
    expect(screen.getByText(PENDING_NOTE)).toBeInTheDocument()
    const table = screen.getByRole('table', {
      name: 'Paid lines with no job, oldest payment first',
    })
    expect(within(table).getByRole('link', { name: 'MDH-1001' })).toHaveAttribute(
      'href',
      `/admin/orders/${ORDER}`,
    )
    expect(within(table).getByText('Renewal')).toBeInTheDocument()
    expect(within(table).getByText('(1 h ago)')).toBeInTheDocument()
    expect(
      screen.getByText(/2 paid certificate lines have no certificate record/),
    ).toBeInTheDocument()
  })

  it('says every line has its job, and counts one certificate line in the singular', () => {
    render(
      <PendingTable
        report={{
          rows: [
            {
              id: LINE,
              orderId: ORDER,
              orderNumber: null,
              domain: 'example.com',
              itemType: 'register',
              status: 'pending',
              paidAt: null,
            },
          ],
          certificateLines: 1,
        }}
        now={NOW}
      />,
    )
    expect(screen.getAllByRole('link', { name: 'Open the order' }).length).toBeGreaterThan(0)
    expect(
      screen.getByText(/1 paid certificate line has no certificate record/),
    ).toBeInTheDocument()
  })

  it('has an empty state', () => {
    render(<PendingTable report={{ rows: [], certificateLines: null }} now={NOW} />)
    expect(screen.getByText('Every paid domain line on this side has its job.')).toBeInTheDocument()
  })
})

describe('QueueStatsPanel', () => {
  it('links each figure to the list it counts, and tabulates 30 days by kind', () => {
    render(
      <QueueStatsPanel
        stats={{
          needsAttention: { jobs: 3, ssl: 0 },
          open: { jobs: 1, ssl: 2 },
          last30: {
            from: '2026-09-04',
            to: '2026-10-03',
            jobs: [
              { kind: 'register_domain', status: 'succeeded', count: 4 },
              { kind: 'register_domain', status: 'failed', count: 1 },
              { kind: 'set_privacy', status: 'needs_attention', count: 3 },
            ],
            ssl: [{ kind: 'ssl_initialize', status: 'queued', count: 2 }],
          },
        }}
      />,
    )
    expect(screen.getByRole('link', { name: /Jobs needing a person\s*3/ })).toHaveAttribute(
      'href',
      '/admin/queue?status=needs_attention',
    )
    expect(
      screen.getByRole('link', { name: /Certificate jobs with the worker\s*2/ }),
    ).toHaveAttribute('href', '/admin/queue/ssl-jobs?status=queued,running')
    const table = screen.getByRole('table')
    expect(within(table).getByText(/Jobs made 4 Sept? 2026 to 3 Oct 2026/)).toBeInTheDocument()
    const rows = within(table).getAllByRole('row')
    expect(within(rows[1] as HTMLElement).getByRole('rowheader')).toHaveTextContent('Registration')
    expect(rows[1]).toHaveTextContent('5')
    // Phones get a line per kind instead of a table that scrolls sideways.
    const list = screen.getByRole('list', { name: /Jobs made 4 Sept? 2026 to 3 Oct 2026/ })
    expect(within(list).getByText('4 done · 1 failed · 5 in all')).toBeInTheDocument()
  })

  it('says when nothing was made', () => {
    render(
      <QueueStatsPanel
        stats={{
          needsAttention: { jobs: 0, ssl: 0 },
          open: { jobs: 0, ssl: 0 },
          last30: { from: '2026-09-04', to: '2026-10-03', jobs: [], ssl: [] },
        }}
      />,
    )
    expect(
      screen.getByText('No jobs were made in the last 30 days on this side.'),
    ).toBeInTheDocument()
  })

  it('orders kinds by how many, then by name', () => {
    expect(
      byKind([
        { kind: 'b', status: 'failed', count: 1 },
        { kind: 'a', status: 'failed', count: 1 },
        { kind: 'c', status: 'queued', count: 2 },
      ]).map((entry) => entry.kind),
    ).toEqual(['c', 'a', 'b'])
  })
})

describe('JobDetailBody', () => {
  it('offers Retry for a failed registration, naming the refund it cancels', async () => {
    const user = userEvent.setup()
    render(<JobDetailBody detail={detail()} side="test" viewer={operator} now={NOW} />)
    expect(screen.getByRole('heading', { level: 1, name: 'example.com' })).toBeInTheDocument()
    expect(screen.getByText('Registration · job 3c9e6b1a')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fail' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Before failing' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Read the registry now' })).toBeInTheDocument()
    expect(screen.getByText(/No playbook entry/)).toBeInTheDocument()

    const line = screen.getByRole('region', { name: 'Order line and refund' })
    expect(within(line).getByRole('link', { name: 'MDH-1001' })).toHaveAttribute(
      'href',
      `/admin/orders/${ORDER}`,
    )
    expect(within(line).getByText('₦1,000 for 1 year, then ₦1,000 every year')).toBeInTheDocument()
    expect(within(line).getByRole('link', { name: 'Refund of ₦1,075' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Supplier calls' })).getAllByText(
        'RegisterWithContactInfo',
      ).length,
    ).toBeGreaterThan(0)
    const timeline = screen.getByRole('region', { name: 'Timeline' })
    expect(within(timeline).getByText('Registration failed')).toBeInTheDocument()
    expect(within(timeline).getByText('By customer')).toBeInTheDocument()
    expect(within(timeline).getByText('Job failed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog).getByText(/Its pending refund of ₦1,075 is cancelled first/),
    ).toBeInTheDocument()
  })

  it('offers Fail for a registration waiting for a person, with the read it needs first', () => {
    render(
      <JobDetailBody
        detail={detail(
          { status: 'needs_attention', lastErrorCode: 'SUPPLIER_TIMEOUT', finishedAt: null },
          {
            refunds: [],
            registryRead: { createdAt: '2026-10-03T11:58:00Z', outcome: 'not_found' },
          },
        )}
        side="test"
        viewer={operator}
        now={NOW}
      />,
    )
    expect(screen.getByRole('button', { name: 'Fail' })).toBeInTheDocument()
    const before = screen.getByRole('region', { name: 'Before failing' })
    expect(before).toHaveTextContent(
      'Last registry read: 3 Oct 2026, 12:58 WAT (not in our account).',
    )
    expect(before).toHaveTextContent('The last registry read is recent and allows Fail.')
    expect(before).toHaveTextContent(/ledger shows a charge for example\.com/)
    // The read sits in the precondition panel, once.
    expect(screen.getAllByRole('button', { name: 'Read the registry now' })).toHaveLength(1)
    expect(screen.getByText(/The supplier did not answer in time/)).toBeInTheDocument()
    expect(
      within(before).getByRole('button', { name: 'Read the registry now' }),
    ).toBeInTheDocument()
  })

  it('keeps only Retry for a renewal, and offers its renewability check', () => {
    render(
      <JobDetailBody
        detail={detail(
          {
            kind: 'renew_domain',
            status: 'needs_attention',
            lastErrorCode: 'SUPPLIER_TIMEOUT',
            baselineExpiry: '2027-01-01T00:00:00Z',
          },
          { registryRead: { createdAt: '2026-10-03T11:58:00Z', outcome: 'ok' } },
        )}
        side="test"
        viewer={operator}
        now={NOW}
      />,
    )
    expect(screen.getByText(ONLY_RETRY_WORDS)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check renewability' })).toBeInTheDocument()
    expect(screen.getByText('Expiry stored before renewing')).toBeInTheDocument()
  })

  it('reads the transfer state for a waiting transfer before Fail', () => {
    render(
      <JobDetailBody
        detail={detail(
          {
            kind: 'transfer_domain',
            status: 'needs_attention',
            lastErrorCode: 'TRANSFER_OVERDUE',
            submittedAt: '2026-09-20T09:00:00Z',
            lockedBy: 'gateway-1',
            lockedAt: '2026-10-03T11:00:00Z',
          },
          {
            refunds: [],
            transferRead: { createdAt: '2026-10-03T11:59:00Z', outcome: 'ok', state: 'rejected' },
            lastAttemptAt: null,
          },
        )}
        side="live"
        viewer={{ role: 'owner', testOnly: false }}
        now={NOW}
      />,
    )
    const before = screen.getByRole('region', { name: 'Before failing' })
    expect(before).toHaveTextContent('(rejected)')
    expect(
      within(before).getByRole('button', { name: 'Read the transfer state' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read the registry now' })).toBeInTheDocument()
    expect(screen.getByText('Submitted to the registry')).toBeInTheDocument()
    expect(screen.getByText(/gateway-1 since/)).toBeInTheDocument()
  })

  it('shows a viewer the job without its buttons', () => {
    render(<JobDetailBody detail={detail()} side="test" viewer={viewer} now={NOW} />)
    expect(
      screen.getByText('Your admin role can look at this job but not change it.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Read the registry now' })).toBeNull()
  })

  it('leaves a job with the worker alone, and a done job too', () => {
    const { unmount } = render(
      <JobDetailBody
        detail={detail(
          { status: 'queued', lastErrorCode: null, finishedAt: null },
          { line: null, refunds: [], domain: null, events: [] },
        )}
        side="test"
        viewer={operator}
        now={NOW}
      />,
    )
    expect(screen.getByText(/The worker has this job/)).toBeInTheDocument()
    expect(screen.getByText(/No order line/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Job 3c9e6b1a' })).toBeInTheDocument()
    expect(screen.getAllByText('Domain 7a1b2c3d').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    unmount()

    render(
      <JobDetailBody
        detail={detail({ status: 'succeeded', lastErrorCode: null }, { refunds: [] })}
        side="test"
        viewer={viewer}
        now={NOW}
      />,
    )
    expect(screen.getByText('Done. Nothing to do.')).toBeInTheDocument()
    expect(screen.getByText('No refund for this line.')).toBeInTheDocument()
    expect(screen.getByText('Job done')).toBeInTheDocument()
  })

  it('says a job is not on this side', () => {
    render(<JobNotFound side="live" />)
    expect(screen.getByText("This job isn't on the Live side.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the queue' })).toHaveAttribute(
      'href',
      '/admin/queue',
    )
  })
})

describe('SslJobDetailBody', () => {
  function ssl(overrides: Partial<SslJobDetail['job']> = {}, rest: Partial<SslJobDetail> = {}) {
    return {
      job: {
        id: JOB,
        kind: 'ssl_initialize',
        status: 'needs_attention',
        attempts: 1,
        lastErrorCode: 'SUPPLIER_TIMEOUT',
        runAfter: '2026-10-03T10:00:00Z',
        sentAt: null,
        createdAt: '2026-10-03T09:00:00Z',
        updatedAt: '2026-10-03T10:00:00Z',
        testMode: true,
        certificateId: DOMAIN,
        finishedAt: null,
        lockedAt: null,
        lockedBy: null,
        ...overrides,
      },
      name: 'example.com',
      calls: [],
      siblings: [],
      ...rest,
    } satisfies SslJobDetail
  }

  it('offers Fail for an order never sent, and links the certificate by id', () => {
    render(<SslJobDetailBody detail={ssl()} side="test" viewer={operator} />)
    expect(screen.getByRole('button', { name: 'Fail' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Certificate 7a1b2c3d' })).toHaveAttribute(
      'href',
      `/admin/ssl/${DOMAIN}`,
    )
    expect(screen.getByText('None.')).toBeInTheDocument()
    expect(screen.getByText('No supplier calls recorded for this job.')).toBeInTheDocument()
  })

  it('never fails an order that may have reached the supplier (N3)', () => {
    render(
      <SslJobDetailBody
        detail={ssl(
          {
            sentAt: '2026-10-03T09:30:00Z',
            lockedBy: 'gateway-1',
            lockedAt: '2026-10-03T09:30:00Z',
          },
          {
            name: null,
            siblings: [
              {
                id: LINE,
                kind: 'ssl_configure',
                status: 'queued',
                createdAt: '2026-10-03T09:00:00Z',
              },
            ],
          },
        )}
        side="test"
        viewer={operator}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Fail' })).toBeNull()
    expect(screen.getByText(ADMIN_ERROR_WORDS.ALREADY_SENT as string)).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: 'Certificate job 3c9e6b1a' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Certificate set-up' })).toHaveAttribute(
      'href',
      `/admin/queue/ssl-jobs/${LINE}`,
    )
  })

  it('shows a viewer no buttons, a busy job the worker note, and a done one as done', () => {
    const { unmount } = render(<SslJobDetailBody detail={ssl()} side="test" viewer={viewer} />)
    expect(
      screen.getByText('Your admin role can look at this job but not change it.'),
    ).toBeInTheDocument()
    unmount()
    const busy = render(
      <SslJobDetailBody detail={ssl({ status: 'running' })} side="test" viewer={operator} />,
    )
    expect(screen.getByText(/The worker has this job/)).toBeInTheDocument()
    busy.unmount()
    render(
      <SslJobDetailBody
        detail={ssl({ status: 'failed', kind: 'ssl_configure', lastErrorCode: null })}
        side="test"
        viewer={operator}
      />,
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop the change' })).toBeNull()
  })
})

describe('JobActions', () => {
  const retry = {
    title: 'Try the registration of example.com again?',
    body: 'The worker reads the registry first.',
    confirmLabel: 'Retry' as const,
    cancelLabel: 'Not now' as const,
    done: 'Back in the queue.',
  }
  const fail = {
    title: 'Fail the registration of example.com and refund ₦1,075?',
    body: 'The line fails.',
    trigger: 'Fail',
    confirmLabel: 'Fail and refund ₦1,075',
    needsRead: 'registry' as const,
    done: 'Failed.',
  }

  it('retries with the reason, a fresh request key and the code', async () => {
    vi.mocked(retryJob).mockResolvedValue({ data: { ok: true, auditId: 1 } } as never)
    const user = userEvent.setup()
    render(
      <JobActions
        jobId={JOB}
        certificate={false}
        retry={retry}
        fail={null}
        typeToConfirm="example.com"
        returnTo={`/admin/queue/jobs/${JOB}`}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Reason'), 'read the registry: free again')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(within(dialog).getByText('Back in the queue.')).toBeInTheDocument())
    expect(retryJob).toHaveBeenCalledWith({
      jobId: JOB,
      reason: 'read the registry: free again',
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      code: '123456',
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('fails with the domain typed back, and shows a refusal in words', async () => {
    vi.mocked(failJob).mockResolvedValue({
      data: { ok: false, code: 'READ_REGISTRY_FIRST', message: 'Read the registry first.' },
    } as never)
    const user = userEvent.setup()
    render(
      <JobActions
        jobId={JOB}
        certificate={false}
        retry={null}
        fail={fail}
        typeToConfirm="example.com"
        returnTo="/admin/queue"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Fail' }))
    const dialog = screen.getByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Fail and refund ₦1,075' })
    await user.type(within(dialog).getByLabelText('Reason'), 'the registry does not have it')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '654321')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText(/Type example\.com to confirm/), 'example.com')
    await user.click(confirm)
    await waitFor(() =>
      expect(within(dialog).getByText('Read the registry first.')).toBeInTheDocument(),
    )
    expect(failJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB, code: '654321' }))
  })

  it('uses the certificate wrappers for a certificate job', async () => {
    vi.mocked(retrySslJob).mockResolvedValue({ data: { ok: true, auditId: 2 } } as never)
    vi.mocked(failSslJob).mockResolvedValue({ data: { ok: true, auditId: 3 } } as never)
    const user = userEvent.setup()
    render(
      <JobActions
        jobId={JOB}
        certificate
        retry={retry}
        fail={{ ...fail, trigger: 'Fail', confirmLabel: 'Fail the order' }}
        typeToConfirm="example.com"
        returnTo="/admin/queue"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    let dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Reason'), 'never sent: order it again')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '111111')
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(retrySslJob).toHaveBeenCalled())
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    await user.click(screen.getByRole('button', { name: 'Fail' }))
    dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Reason'), 'the customer asked to stop')
    await user.type(within(dialog).getByLabelText(/to confirm/), 'example.com')
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '222222')
    await user.click(within(dialog).getByRole('button', { name: 'Fail the order' }))
    await waitFor(() => expect(failSslJob).toHaveBeenCalled())
    expect(retryJob).not.toHaveBeenCalled()
    expect(failJob).not.toHaveBeenCalled()
  })

  it('renders nothing when neither is offered', () => {
    const { container } = render(
      <JobActions
        jobId={JOB}
        certificate={false}
        retry={null}
        fail={null}
        typeToConfirm="example.com"
        returnTo="/admin/queue"
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('LiveRead', () => {
  const readAt = '2026-10-03T11:05:00.000Z'

  it('reads the registry on a click, says what it found, and re-reads the page', async () => {
    vi.mocked(lookupDomain).mockResolvedValue({
      data: {
        ok: true,
        auditId: 1,
        data: {
          name: 'example.com',
          outcome: 'not_found',
          status: null,
          statusCode: null,
          expiresAt: null,
          rgpExpiresAt: null,
          transferLock: null,
          privacy: null,
          nameservers: [],
          readAt,
        },
      },
    } as never)
    const user = userEvent.setup()
    render(<LiveRead kind="registry" name="example.com" returnTo="/admin/queue" />)
    expect(lookupDomain).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Read the registry now' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Read at 12:05 WAT: not in our account'),
    )
    expect(lookupDomain).toHaveBeenCalledWith({ name: 'example.com' })
    expect(refresh).toHaveBeenCalled()
  })

  it('reads a transfer state and a renewability check', async () => {
    vi.mocked(readTransferState).mockResolvedValue({
      data: {
        ok: true,
        auditId: 1,
        data: {
          name: 'example.com',
          state: 'completed',
          supplierStatus: 'completed',
          requestedAt: null,
          finalAt: null,
          readAt,
        },
      },
    } as never)
    vi.mocked(checkRenewable).mockResolvedValue({
      data: {
        ok: true,
        auditId: 2,
        data: { name: 'example.com', renewable: true, renewalLock: false, reasonKey: null, readAt },
      },
    } as never)
    const user = userEvent.setup()
    render(
      <>
        <LiveRead kind="transfer" name="example.com" returnTo="/admin/queue" />
        <LiveRead kind="renew" name="example.com" returnTo="/admin/queue" />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Read the transfer state' }))
    await user.click(screen.getByRole('button', { name: 'Check renewability' }))
    await waitFor(() =>
      expect(screen.getByText(/landed — record it in the SQL editor/)).toBeInTheDocument(),
    )
    await waitFor(() =>
      expect(
        screen.getByText('Read at 12:05 WAT: the registry would renew it'),
      ).toBeInTheDocument(),
    )
  })

  it('says why a read was refused, or that it never came back', async () => {
    vi.mocked(lookupDomain).mockResolvedValueOnce({
      data: { ok: false, code: 'TOO_SOON', message: ADMIN_ERROR_WORDS.TOO_SOON },
    } as never)
    vi.mocked(lookupDomain).mockRejectedValueOnce(new Error('network'))
    vi.mocked(lookupDomain).mockResolvedValueOnce({ data: { ok: true, auditId: 1 } } as never)
    const user = userEvent.setup()
    render(<LiveRead kind="registry" name="example.com" returnTo="/admin/queue" />)
    const button = screen.getByRole('button', { name: 'Read the registry now' })
    await user.click(button)
    await waitFor(() =>
      expect(screen.getByText(ADMIN_ERROR_WORDS.TOO_SOON as string)).toBeInTheDocument(),
    )
    await user.click(button)
    await waitFor(() =>
      expect(
        screen.getByText("The read didn't come back. Nothing was changed; try again."),
      ).toBeInTheDocument(),
    )
    await user.click(button)
    await waitFor(() =>
      expect(screen.getByText('The registry answered nothing we could read.')).toBeInTheDocument(),
    )
    expect(refresh).not.toHaveBeenCalled()
    expect(LOST_ANSWER_WORDS).toBeTruthy()
  })

  it('says a transfer or renewal read was refused', async () => {
    vi.mocked(readTransferState).mockResolvedValue({
      data: { ok: false, code: 'OTHER_SIDE', message: ADMIN_ERROR_WORDS.OTHER_SIDE },
    } as never)
    vi.mocked(checkRenewable).mockResolvedValue({ data: { ok: true, auditId: 1 } } as never)
    const user = userEvent.setup()
    render(
      <>
        <LiveRead kind="transfer" name="example.com" returnTo="/admin/queue" />
        <LiveRead kind="renew" name="example.com" returnTo="/admin/queue" />
      </>,
    )
    await user.click(screen.getByRole('button', { name: 'Read the transfer state' }))
    await waitFor(() =>
      expect(screen.getByText(ADMIN_ERROR_WORDS.OTHER_SIDE as string)).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: 'Check renewability' }))
    await waitFor(() =>
      expect(screen.getByText('The registry answered nothing we could read.')).toBeInTheDocument(),
    )
  })
})
