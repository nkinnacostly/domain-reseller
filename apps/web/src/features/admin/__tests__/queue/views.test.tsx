import { render, screen } from '@testing-library/react'
import { redirect } from 'next/navigation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JobsView,
  JobView,
  PendingView,
  SslJobsView,
  SslJobView,
} from '@/features/admin/components/queue/views'
import {
  getJob,
  getQueueStats,
  getSslJob,
  listJobs,
  listPendingWithoutJob,
  listSslJobs,
} from '@/features/admin/queries/queue'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/admin/queue',
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  }),
}))
vi.mock('@/features/admin/components/shell/side-switch', () => ({
  SideSwitch: () => null,
}))
vi.mock('@/features/admin/actions/jobs', () => ({}))
vi.mock('@/features/admin/actions/supplier-live', () => ({}))
vi.mock('@/features/admin/queries/session', () => ({
  requireAdmin: vi.fn(),
  getAdminSide: vi.fn(),
}))
vi.mock('@/features/admin/queries/queue', () => ({
  listJobs: vi.fn(),
  getQueueStats: vi.fn(),
  listSslJobs: vi.fn(),
  listPendingWithoutJob: vi.fn(),
  getJob: vi.fn(),
  getSslJob: vi.fn(),
}))

const JOB = '3c9e6b1a-1d2f-4e5a-8b7c-6d5e4f3a2b1c'
const admin = { role: 'operator', testOnly: true, label: 'e2e' }
const stats = {
  needsAttention: { jobs: 1, ssl: 0 },
  open: { jobs: 0, ssl: 0 },
  last30: { from: '2026-09-04', to: '2026-10-03', jobs: [], ssl: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue(admin as never)
  vi.mocked(getAdminSide).mockResolvedValue('test')
})

describe('JobsView', () => {
  it('reads the list with the URL’s filters and shows the figures and the list', async () => {
    vi.mocked(listJobs).mockResolvedValue({ rows: [], total: 0 })
    vi.mocked(getQueueStats).mockResolvedValue(stats)
    render(
      await JobsView({
        searchParams: Promise.resolve({ status: 'failed', kind: 'set_privacy', domain: JOB }),
      }),
    )
    expect(listJobs).toHaveBeenCalledWith(
      admin,
      'test',
      expect.objectContaining({ status: ['failed'] }),
      { kind: 'set_privacy', domainId: JOB },
    )
    expect(screen.getByRole('region', { name: 'At a glance' })).toBeInTheDocument()
    expect(screen.getByText('No jobs match these filters.')).toBeInTheDocument()
  })

  it('shows an error state for each read that failed, never an empty list', async () => {
    vi.mocked(listJobs).mockRejectedValue(new Error('down'))
    vi.mocked(getQueueStats).mockRejectedValue(new Error('down'))
    render(await JobsView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText("The queue couldn't be read.")).toBeInTheDocument()
    expect(screen.getByText("The queue's figures couldn't be read.")).toBeInTheDocument()
  })

  it('sends a `?tab=` link to its own page', async () => {
    await expect(JobsView({ searchParams: Promise.resolve({ tab: 'pending' }) })).rejects.toThrow(
      'NEXT_REDIRECT /admin/queue/pending',
    )
    expect(redirect).toHaveBeenCalledWith('/admin/queue/pending')
    expect(listJobs).not.toHaveBeenCalled()
  })
})

describe('SslJobsView and PendingView', () => {
  it('list certificate jobs and paid lines, or say they could not be read', async () => {
    vi.mocked(listSslJobs).mockResolvedValue({ rows: [], total: 0 })
    render(await SslJobsView({ searchParams: Promise.resolve({ kind: 'ssl_reissue' }) }))
    expect(listSslJobs).toHaveBeenCalledWith(admin, 'test', expect.anything(), {
      kind: 'ssl_reissue',
      domainId: null,
    })
    expect(screen.getByText('No certificate jobs match these filters.')).toBeInTheDocument()

    vi.mocked(listSslJobs).mockRejectedValue(new Error('down'))
    render(await SslJobsView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText("The queue couldn't be read.")).toBeInTheDocument()

    vi.mocked(listPendingWithoutJob).mockResolvedValue({ rows: [], certificateLines: 0 })
    render(await PendingView())
    expect(screen.getByText('Every paid domain line on this side has its job.')).toBeInTheDocument()

    vi.mocked(listPendingWithoutJob).mockRejectedValue(new Error('down'))
    render(await PendingView())
    expect(screen.getByText("The paid lines couldn't be read.")).toBeInTheDocument()
  })
})

describe('JobView and SslJobView', () => {
  it('say a job is not on this side, without reading for an id that is not one', async () => {
    vi.mocked(getJob).mockResolvedValue(null)
    render(await JobView({ params: Promise.resolve({ id: JOB }) }))
    expect(screen.getByText("This job isn't on the Test side.")).toBeInTheDocument()

    render(await JobView({ params: Promise.resolve({ id: 'example.com' }) }))
    expect(getJob).toHaveBeenCalledTimes(1)

    vi.mocked(getSslJob).mockResolvedValue(null)
    render(await SslJobView({ params: Promise.resolve({ id: JOB }) }))
    expect(screen.getByText("This certificate job isn't on the Test side.")).toBeInTheDocument()
    render(await SslJobView({ params: Promise.resolve({ id: 'nope' }) }))
    expect(getSslJob).toHaveBeenCalledTimes(1)
  })

  it('show an error state when a job cannot be read', async () => {
    vi.mocked(getJob).mockRejectedValue(new Error('down'))
    render(await JobView({ params: Promise.resolve({ id: JOB }) }))
    expect(screen.getByText("This job couldn't be read.")).toBeInTheDocument()

    vi.mocked(getSslJob).mockRejectedValue(new Error('down'))
    render(await SslJobView({ params: Promise.resolve({ id: JOB }) }))
    expect(screen.getByText("This certificate job couldn't be read.")).toBeInTheDocument()
  })

  it('render a job that was read', async () => {
    vi.mocked(getJob).mockResolvedValue({
      job: {
        id: JOB,
        kind: 'set_privacy',
        status: 'succeeded',
        attempts: 1,
        lastErrorCode: null,
        runAfter: '2026-10-03T10:00:00Z',
        createdAt: '2026-10-03T09:00:00Z',
        updatedAt: '2026-10-03T10:00:00Z',
        finishedAt: '2026-10-03T10:00:00Z',
        submittedAt: null,
        baselineExpiry: null,
        lockedAt: null,
        lockedBy: null,
        testMode: true,
        domainId: JOB,
        orderItemId: null,
      },
      domain: null,
      line: null,
      orderLines: [],
      order: null,
      refunds: [],
      calls: [],
      registryRead: null,
      transferRead: null,
      lastAttemptAt: null,
      ledger: null,
      events: [],
    })
    render(await JobView({ params: Promise.resolve({ id: JOB }) }))
    expect(screen.getByText('Done. Nothing to do.')).toBeInTheDocument()

    vi.mocked(getSslJob).mockResolvedValue({
      job: {
        id: JOB,
        kind: 'ssl_reissue',
        status: 'succeeded',
        attempts: 1,
        lastErrorCode: null,
        runAfter: '2026-10-03T10:00:00Z',
        sentAt: '2026-10-03T09:30:00Z',
        createdAt: '2026-10-03T09:00:00Z',
        updatedAt: '2026-10-03T10:00:00Z',
        testMode: true,
        certificateId: JOB,
        finishedAt: '2026-10-03T10:00:00Z',
        lockedAt: null,
        lockedBy: null,
      },
      name: 'example.com',
      calls: [],
      siblings: [],
      line: null,
      orderLines: [],
      order: null,
      refunds: [],
    })
    render(await SslJobView({ params: Promise.resolve({ id: JOB }) }))
    expect(screen.getByRole('heading', { level: 1, name: 'example.com' })).toBeInTheDocument()
  })
})
