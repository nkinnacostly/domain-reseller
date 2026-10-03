import { render, screen, within } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertHistory, OpenAlerts } from '@/features/admin/components/alerts/alert-lists'
import { AlertTabs, SeverityPill } from '@/features/admin/components/alerts/alert-parts'
import { AlertsSkeleton, AlertsView } from '@/features/admin/components/alerts/alerts-view'
import { DriftList } from '@/features/admin/components/alerts/drift-list'
import { HealthTab } from '@/features/admin/components/alerts/health'
import { OPEN_NOTE, TEST_SIDE_NOTE } from '@/features/admin/lib/alerts-copy'
import { type AlertsParams, parseAlertsParams } from '@/features/admin/lib/alerts-params'
import type { AlertRow } from '@/features/admin/queries/alerts'
import type { AdminPrincipal } from '@/features/admin/queries/session'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/admin/alerts',
}))
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute: vi.fn(), isPending: false, result: {} }),
}))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))

const queries = vi.hoisted(() => ({
  listOpenAlerts: vi.fn(),
  listAlertHistory: vi.fn(),
  getAlertStats: vi.fn(),
  listOpenDrift: vi.fn(),
  listHeartbeats: vi.fn(),
  getReconcileRuns: vi.fn(),
  getCronHealth: vi.fn(),
  RUN_DAYS: 7,
}))
vi.mock('@/features/admin/queries/alerts', () => queries)
const session = vi.hoisted(() => ({ requireAdmin: vi.fn(), getAdminSide: vi.fn() }))
vi.mock('@/features/admin/queries/session', () => session)

/**
 * The alerts page as an admin sees it (ADMIN-SPEC §5.2, B5): each tab's
 * success, empty and error states, links through adminHrefForAlertKey, the
 * Test-side note, no dismiss control anywhere, and no cron panel for a test
 * administrator.
 */

/** Renders server components: awaits each async one in the tree, and any sync one listed. */
async function resolve(
  node: ReactNode,
  expand: ReadonlySet<unknown> = new Set(),
): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolve(child, expand)))
  if (!isValidElement(node)) return node
  const { type, props } = node as { type: unknown; props: { children?: ReactNode } }
  if (
    typeof type === 'function' &&
    (type.constructor.name === 'AsyncFunction' || expand.has(type))
  ) {
    return resolve(await (type as (p: unknown) => ReactNode | Promise<ReactNode>)(props), expand)
  }
  if (props.children === undefined) return node
  const children = await resolve(props.children, expand)
  // Spread a list back as separate children, as JSX wrote them, so React asks for no keys.
  return Array.isArray(children)
    ? cloneElement(node, undefined, ...children)
    : cloneElement(node, undefined, children)
}

const owner = { label: 'owner', role: 'owner', testOnly: false } as unknown as AdminPrincipal
const tester = { label: 'e2e-1', role: 'operator', testOnly: true } as unknown as AdminPrincipal
const now = new Date('2026-10-03T12:00:00Z')

const alert = (overrides: Partial<AlertRow> = {}): AlertRow => ({
  id: 11,
  severity: 'critical',
  kind: 'refund_overdue',
  summary: 'Refund for MDH-1001 is overdue',
  firstSeenAt: '2026-10-02T08:00:00Z',
  lastSeenAt: '2026-10-03T11:00:00Z',
  notifyCount: 3,
  resolvedAt: null,
  href: '/admin/refunds/0b6a52a1-55c4-4f0e-9a3e-2b8c1d2e3f40',
  ...overrides,
})

const stats = {
  ok: true,
  data: {
    byKind: [
      { kind: 'refund_overdue', severity: 'critical', open: 1, resolved: 0 },
      { kind: 'email_failed', severity: 'warning', open: 0, resolved: 4 },
    ],
    reconcile: null,
    drift: [],
    presets: { hidden: 1, failing: 0, stale: 2, drafts: 1 },
  },
}

const params = <T extends AlertsParams['tab']>(query: string) =>
  parseAlertsParams(new URLSearchParams(query)) as Extract<AlertsParams, { tab: T }>

beforeEach(() => {
  vi.clearAllMocks()
  session.requireAdmin.mockResolvedValue(owner)
  session.getAdminSide.mockResolvedValue('live')
  queries.getAlertStats.mockResolvedValue(stats)
})

/** No control on the page acts on an alert. */
function expectNoDismiss() {
  for (const name of [/dismiss/i, /resolve/i, /acknowledge/i, /close alert/i, /mute/i]) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
}

describe('the tabs', () => {
  it('mark the open view as the current page, in words and a tick as well as colour', () => {
    render(<AlertTabs current="drift" />)
    const nav = screen.getByRole('navigation', { name: 'Alert views' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/admin/alerts',
      '/admin/alerts?tab=history',
      '/admin/alerts?tab=drift',
      '/admin/alerts?tab=health',
    ])
    expect(within(nav).getByRole('link', { name: 'Drift' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Open' })).not.toHaveAttribute('aria-current')
    expect(within(nav).getByRole('link', { name: 'Drift' }).querySelector('svg')).not.toBeNull()
  })

  it('give each severity a word and its own icon', () => {
    render(
      <>
        <SeverityPill severity="critical" />
        <SeverityPill severity="warning" />
        <SeverityPill severity="odd" />
      </>,
    )
    expect(screen.getByText('Critical')).toBeInTheDocument()
    expect(screen.getByText('Warning')).toBeInTheDocument()
    expect(screen.getByText('odd')).toBeInTheDocument()
  })
})

describe('the page', () => {
  it('shows the header, side switch and tabs, and the Test-side note only on the test side', async () => {
    queries.listOpenAlerts.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    session.getAdminSide.mockResolvedValue('test')
    const { AlertsTab } = await import('@/features/admin/components/alerts/alerts-view')
    render(
      await resolve(await AlertsView({ searchParams: Promise.resolve({}) }), new Set([AlertsTab])),
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Alerts and health' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Records shown' })).toBeInTheDocument()
    expect(screen.getByText(TEST_SIDE_NOTE)).toBeInTheDocument()
    expect(screen.getByText('No open alerts')).toBeInTheDocument()
    expectNoDismiss()
  })

  it('leaves the Test-side note off the live side, and off drift and health', async () => {
    queries.listOpenAlerts.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    queries.listOpenDrift.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    const { AlertsTab } = await import('@/features/admin/components/alerts/alerts-view')
    const { unmount } = render(
      await resolve(await AlertsView({ searchParams: Promise.resolve({}) }), new Set([AlertsTab])),
    )
    expect(screen.queryByText(TEST_SIDE_NOTE)).toBeNull()
    unmount()
    session.getAdminSide.mockResolvedValue('test')
    render(
      await resolve(
        await AlertsView({ searchParams: Promise.resolve({ tab: 'drift' }) }),
        new Set([AlertsTab]),
      ),
    )
    expect(screen.queryByText(TEST_SIDE_NOTE)).toBeNull()
    expect(screen.getByText('No drift')).toBeInTheDocument()
  })

  it('has a skeleton while it loads', () => {
    const { container } = render(<AlertsSkeleton />)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('open alerts', () => {
  it('list each alert with its severity, summary and a link to where it is worked', async () => {
    queries.listOpenAlerts.mockResolvedValue({
      ok: true,
      data: {
        total: 2,
        rows: [
          alert(),
          alert({
            id: 12,
            severity: 'warning',
            kind: 'drift_supplier_may_renew',
            summary: 'example.com may renew at the registry',
            href: '/admin/alerts?tab=drift',
          }),
        ],
      },
    })
    render(await resolve(<OpenAlerts admin={owner} side="live" params={params('')} now={now} />))
    const table = screen.getByRole('table', { name: 'Open alerts, critical first' })
    const links = within(table).getAllByRole('link', { name: /for the alert/ })
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/admin/refunds/0b6a52a1-55c4-4f0e-9a3e-2b8c1d2e3f40',
      '/admin/alerts?tab=drift',
    ])
    expect(links[0]).toHaveAccessibleName('Refund, for the alert “Refund overdue”')
    expect(links[0]).toHaveAttribute('data-alert-id', '11')
    expect(within(table).getByText('Refund for MDH-1001 is overdue')).toBeInTheDocument()
    expect(within(table).getAllByText('Critical').length).toBeGreaterThan(0)
    expect(screen.getAllByText(OPEN_NOTE).length).toBeGreaterThan(0)
    // Severity is sorted ascending (critical first), and says so.
    expect(within(table).getByRole('columnheader', { name: /Severity/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByText('2 open')).toBeInTheDocument()
    expectNoDismiss()
  })

  it('say when nothing is open, and point to the history', async () => {
    queries.listOpenAlerts.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    render(await resolve(<OpenAlerts admin={owner} side="live" params={params('')} now={now} />))
    expect(screen.getByText('No open alerts')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See the history' })).toHaveAttribute(
      'href',
      '/admin/alerts?tab=history',
    )
  })

  it('narrow to one severity from the overview’s ?severity=critical, with a way back', async () => {
    queries.listOpenAlerts.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    const narrowed = params('severity=critical') as Parameters<typeof OpenAlerts>[0]['params']
    render(await resolve(<OpenAlerts admin={owner} side="live" params={narrowed} now={now} />))
    expect(queries.listOpenAlerts).toHaveBeenCalledWith(owner, 'live', narrowed.list, 'critical')
    const chips = screen.getByRole('navigation', { name: 'Severity' })
    expect(within(chips).getByRole('link', { name: 'Critical' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByText('No open critical alerts')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show every open alert' })).toHaveAttribute(
      'href',
      '/admin/alerts',
    )
  })

  it('offer to try again when they cannot be read', async () => {
    queries.listOpenAlerts.mockResolvedValue({ ok: false })
    render(await resolve(<OpenAlerts admin={owner} side="live" params={params('')} now={now} />))
    expect(screen.getByRole('alert')).toHaveTextContent("The open alerts couldn't be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('say a page past the end is past the end, not that nothing is open', async () => {
    queries.listOpenAlerts.mockResolvedValue({ ok: true, data: { rows: [], total: 3 } })
    render(
      await resolve(<OpenAlerts admin={owner} side="live" params={params('page=9')} now={now} />),
    )
    expect(screen.queryByText('No open alerts')).toBeNull()
    expect(screen.getByText('Nothing on this page')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/alerts',
    )
  })

  it('page through a long list', async () => {
    queries.listOpenAlerts.mockResolvedValue({ ok: true, data: { rows: [alert()], total: 120 } })
    render(
      await resolve(<OpenAlerts admin={owner} side="live" params={params('page=2')} now={now} />),
    )
    const pages = screen.getByRole('navigation', { name: 'Pages' })
    expect(within(pages).getByRole('link', { name: /Next/ })).toHaveAttribute(
      'href',
      '/admin/alerts?page=3',
    )
    expect(within(pages).getByRole('link', { name: /Previous/ })).toHaveAttribute(
      'href',
      '/admin/alerts',
    )
  })
})

describe('alert history', () => {
  it('lists open and closed alerts with their figures and filters', async () => {
    queries.listAlertHistory.mockResolvedValue({
      ok: true,
      data: {
        total: 2,
        rows: [
          alert({ resolvedAt: '2026-10-03T11:30:00Z', notifyCount: 1 }),
          alert({
            id: 13,
            kind: 'email_failed',
            severity: 'warning',
            notifyCount: 0,
            href: '/admin/emails?status=failed',
          }),
        ],
      },
    })
    const history = params<'history'>('tab=history&kind=refund_overdue&from=2026-10-01')
    render(await resolve(<AlertHistory admin={owner} side="live" params={history} now={now} />))
    expect(queries.listAlertHistory).toHaveBeenCalledWith(
      owner,
      'live',
      history.list,
      'refund_overdue',
    )
    expect(queries.getAlertStats).toHaveBeenCalledWith('live', 30)

    const table = screen.getByRole('table', { name: 'Alert history' })
    expect(within(table).getByText('Closed')).toBeInTheDocument()
    expect(within(table).getByText('Open')).toBeInTheDocument()
    expect(within(table).getByText('Once')).toBeInTheDocument()
    expect(within(table).getByText('Not sent')).toBeInTheDocument()
    expect(
      within(table).getByRole('link', { name: 'Emails, for the alert “Email failed”' }),
    ).toHaveAttribute('href', '/admin/emails?status=failed')

    // Stats from admin_alert_stats.
    expect(screen.getByText('Open now').nextElementSibling).toHaveTextContent('1')
    expect(
      screen.getByText('Raised and closed, last 30 days').nextElementSibling,
    ).toHaveTextContent('4')

    const kinds = screen.getByRole('navigation', { name: 'Alert kind' })
    expect(within(kinds).getByRole('link', { name: /Refund overdue \(1\)/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(kinds).getByRole('link', { name: /Email failed \(4\)/ })).toHaveAttribute(
      'href',
      '/admin/alerts?from=2026-10-01&kind=email_failed&tab=history',
    )
    const states = screen.getByRole('navigation', { name: 'Alert state' })
    expect(within(states).getByRole('link', { name: 'Closed' })).toHaveAttribute(
      'href',
      '/admin/alerts?status=resolved&from=2026-10-01&kind=refund_overdue&tab=history',
    )

    const dates = screen.getByRole('form', { name: 'Seen between' })
    expect(within(dates).getByLabelText('Seen on or after')).toHaveValue('2026-10-01')
    expect(dates.querySelector('input[name="tab"]')).toHaveValue('history')
    expect(dates.querySelector('input[name="kind"]')).toHaveValue('refund_overdue')
    expect(within(dates).getByRole('link', { name: 'Clear the dates' })).toHaveAttribute(
      'href',
      '/admin/alerts?kind=refund_overdue&tab=history',
    )
    expectNoDismiss()
  })

  it('shows a chosen kind outside the window as chosen, and says nothing matches', async () => {
    queries.listAlertHistory.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    render(
      await resolve(
        <AlertHistory
          admin={owner}
          side="live"
          params={params<'history'>('tab=history&kind=admin_burst')}
          now={now}
        />,
      ),
    )
    const kinds = screen.getByRole('navigation', { name: 'Alert kind' })
    expect(within(kinds).getByRole('link', { name: /Many customer look-ups/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByText('No alerts match these filters')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear the filters' })).toHaveAttribute(
      'href',
      '/admin/alerts?tab=history',
    )
  })

  it('offers the first page of the same filters when the page asked for is past the end', async () => {
    queries.listAlertHistory.mockResolvedValue({ ok: true, data: { rows: [], total: 5 } })
    render(
      await resolve(
        <AlertHistory
          admin={owner}
          side="live"
          params={params<'history'>('tab=history&status=open&page=3')}
          now={now}
        />,
      ),
    )
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/alerts?status=open&tab=history',
    )
  })

  it('keeps the list when the stats fail, and shows an error when the list does', async () => {
    queries.getAlertStats.mockResolvedValue({ ok: false })
    queries.listAlertHistory.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    const { unmount } = render(
      await resolve(
        <AlertHistory
          admin={owner}
          side="test"
          params={params<'history'>('tab=history')}
          now={now}
        />,
      ),
    )
    expect(screen.getByText(/counts by kind couldn't be loaded/)).toBeInTheDocument()
    expect(screen.getByText('No alerts on this side yet')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Alert kind' })).toBeNull()
    unmount()

    queries.listAlertHistory.mockResolvedValue({ ok: false })
    render(
      await resolve(
        <AlertHistory
          admin={owner}
          side="test"
          params={params<'history'>('tab=history')}
          now={now}
        />,
      ),
    )
    expect(screen.getByRole('alert')).toHaveTextContent("The alert history couldn't be loaded.")
  })
})

describe('drift', () => {
  it('lists open drift read-only, linking a domain we hold to its page', async () => {
    queries.listOpenDrift.mockResolvedValue({
      ok: true,
      data: {
        total: 2,
        rows: [
          {
            id: 1,
            domainName: 'example.com',
            domainHref: '/admin/domains/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
            kind: 'status_mismatch',
            ours: 'Status active',
            registry: 'Status clientHold',
            firstSeenAt: '2026-10-01T00:00:00Z',
            lastSeenAt: '2026-10-03T00:00:00Z',
            lastRun: { at: '2026-10-03T00:00:02Z', failed: true },
          },
          {
            id: 2,
            domainName: 'stranger.com',
            domainHref: null,
            kind: 'unknown_domain',
            ours: 'No record',
            registry: 'Status Active',
            firstSeenAt: '2026-10-01T00:00:00Z',
            lastSeenAt: '2026-10-03T00:00:00Z',
            lastRun: null,
          },
        ],
      },
    })
    render(
      await resolve(
        <DriftList admin={owner} side="live" params={params<'drift'>('tab=drift')} now={now} />,
      ),
    )
    const table = screen.getByRole('table', { name: 'Open registry drift' })
    expect(within(table).getByRole('link', { name: 'example.com' })).toHaveAttribute(
      'href',
      '/admin/domains/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    )
    expect(within(table).queryByRole('link', { name: 'stranger.com' })).toBeNull()
    expect(within(table).getByText('Status differs')).toBeInTheDocument()
    expect(within(table).getByText('Status clientHold')).toBeInTheDocument()
    expect(within(table).getByText('That check failed')).toBeInTheDocument()
    expect(screen.getByTestId('drift-note')).toHaveTextContent(
      'Drift closes when the next complete reconcile no longer finds it.',
    )
    expectNoDismiss()
  })

  it('offers the first page when the page asked for is past the end', async () => {
    queries.listOpenDrift.mockResolvedValue({ ok: true, data: { rows: [], total: 2 } })
    render(
      await resolve(
        <DriftList
          admin={owner}
          side="live"
          params={params<'drift'>('tab=drift&page=4')}
          now={now}
        />,
      ),
    )
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/alerts?tab=drift',
    )
  })

  it('says when there is none, and offers to try again when it cannot be read', async () => {
    queries.listOpenDrift.mockResolvedValue({ ok: true, data: { rows: [], total: 0 } })
    const drift = params<'drift'>('tab=drift')
    const { unmount } = render(
      await resolve(<DriftList admin={owner} side="live" params={drift} now={now} />),
    )
    expect(screen.getByText('No drift')).toBeInTheDocument()
    unmount()
    queries.listOpenDrift.mockResolvedValue({ ok: false })
    render(await resolve(<DriftList admin={owner} side="live" params={drift} now={now} />))
    expect(screen.getByRole('alert')).toHaveTextContent("The registry drift couldn't be loaded.")
  })
})

describe('health', () => {
  const HEALTH = new Set<unknown>([HealthTab])
  const runs = {
    ok: true,
    data: {
      runs: 3,
      failed: 1,
      averageSeconds: 2.5,
      recent: [
        {
          id: 'r1',
          startedAt: '2026-10-03T11:00:00Z',
          finishedAt: '2026-10-03T11:00:02Z',
          seconds: 2,
          domainsSeen: 4,
          findings: 0,
          outcome: { label: 'Done', tone: 'ok' },
        },
        {
          id: 'r2',
          startedAt: '2026-10-03T10:00:00Z',
          finishedAt: '2026-10-03T10:00:03Z',
          seconds: 3,
          domainsSeen: null,
          findings: null,
          outcome: { label: 'Failed (API_301)', tone: 'danger' },
        },
      ],
    },
  }

  it('shows a real admin every service, the ledger read, the checks, the presets and the cron jobs', async () => {
    queries.listHeartbeats.mockResolvedValue({
      ok: true,
      data: [
        { name: 'gateway:production', side: 'live', beatAt: '2026-10-03T11:55:00Z', outcome: null },
        {
          name: 'supplier_ledger:production',
          side: 'live',
          beatAt: '2026-10-03T11:00:00Z',
          outcome: 'ok',
        },
      ],
    })
    queries.getReconcileRuns.mockResolvedValue(runs)
    queries.getCronHealth.mockResolvedValue({
      ok: true,
      data: [
        {
          job: 'email-notices',
          schedule: '5 6 * * *',
          lastRunAt: '2026-10-03T05:05:00Z',
          lastStatus: 'failed',
          lastSuccessAt: '2026-10-02T05:05:00Z',
        },
        { job: 'never-run', schedule: '', lastRunAt: null, lastStatus: null, lastSuccessAt: null },
      ],
    })
    render(await resolve(<HealthTab admin={owner} side="live" now={now} />, HEALTH))

    const services = screen.getByRole('table', { name: 'Service heartbeats' })
    expect(within(services).getByText('Gateway (live)')).toBeInTheDocument()
    expect(within(services).getByText('Not recorded')).toBeInTheDocument()
    expect(
      screen.getByText('Supplier ledger last read (Live)').nextElementSibling,
    ).toHaveTextContent('1 h ago')

    expect(screen.getByText('Checks that failed').nextElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Average check').nextElementSibling).toHaveTextContent('2.5 s')
    const checks = screen.getByRole('table', { name: 'The last 2 registry checks' })
    expect(within(checks).getByText('Failed (API_301)')).toBeInTheDocument()

    const hidden = screen.getByRole('link', { name: /Hidden from customers/ })
    expect(hidden).toHaveAttribute('href', '/admin/settings/presets')
    expect(hidden).toHaveAccessibleName(expect.stringContaining('1'))

    expect(screen.getByRole('heading', { level: 2, name: 'Scheduled jobs' })).toBeInTheDocument()
    const cron = screen.getByRole('table', { name: 'Scheduled jobs' })
    expect(within(cron).getByText('email-notices')).toBeInTheDocument()
    expect(within(cron).getByText('Failed')).toBeInTheDocument()
    expect(within(cron).getByText('Never run')).toBeInTheDocument()
    expect(queries.getCronHealth).toHaveBeenCalledWith(owner, 'live')
    expectNoDismiss()
  })

  it('shows a test administrator no heartbeats and no cron panel (§5.2)', async () => {
    queries.listHeartbeats.mockResolvedValue({ ok: true, hidden: true })
    queries.getReconcileRuns.mockResolvedValue({
      ok: true,
      data: { runs: 0, failed: 0, averageSeconds: null, recent: [] },
    })
    render(await resolve(<HealthTab admin={tester} side="test" now={now} />, HEALTH))
    expect(screen.getByText('Not shown to test administrators')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Scheduled jobs' })).toBeNull()
    expect(screen.queryByRole('table', { name: 'Scheduled jobs' })).toBeNull()
    expect(queries.getCronHealth).not.toHaveBeenCalled()
    expect(
      screen.getByText('No registry checks on this side in the last 7 days'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Drafts waiting/ })).toHaveAttribute(
      'href',
      '/admin/settings/presets',
    )
  })

  it('fails each part on its own, with a way to try again', async () => {
    queries.listHeartbeats.mockResolvedValue({ ok: false })
    queries.getReconcileRuns.mockResolvedValue({ ok: false })
    queries.getAlertStats.mockResolvedValue({ ok: false })
    queries.getCronHealth.mockResolvedValue({ ok: false })
    render(await resolve(<HealthTab admin={owner} side="live" now={now} />, HEALTH))
    const errors = screen.getAllByRole('alert').map((node) => node.textContent)
    expect(errors).toEqual([
      expect.stringContaining("The service heartbeats couldn't be loaded."),
      expect.stringContaining("The registry checks couldn't be loaded."),
      expect.stringContaining("The host presets' health couldn't be loaded."),
      expect.stringContaining("The scheduled jobs couldn't be loaded."),
    ])
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(4)
  })

  it('says when there are no heartbeats, no ledger read and no jobs yet', async () => {
    queries.listHeartbeats.mockResolvedValue({ ok: true, data: [] })
    queries.getReconcileRuns.mockResolvedValue(runs)
    queries.getCronHealth.mockResolvedValue({ ok: true, data: [] })
    render(await resolve(<HealthTab admin={owner} side="test" now={now} />, HEALTH))
    expect(screen.getByText('No heartbeats yet')).toBeInTheDocument()
    expect(
      screen.getByText('Supplier ledger last read (Test)').nextElementSibling,
    ).toHaveTextContent('Never')
    expect(screen.getByText('No scheduled jobs')).toBeInTheDocument()
  })
})
