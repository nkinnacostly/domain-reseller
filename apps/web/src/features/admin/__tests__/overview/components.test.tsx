import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttentionTiles } from '@/features/admin/components/overview/attention-tiles'
import { FloatTiles } from '@/features/admin/components/overview/float-tiles'
import { HealthStrip } from '@/features/admin/components/overview/health-strip'
import { KpiRow } from '@/features/admin/components/overview/kpi-row'
import { OverviewCharts } from '@/features/admin/components/overview/overview-charts'
import {
  BusinessSkeleton,
  OverviewSkeleton,
  TilesSkeleton,
} from '@/features/admin/components/overview/overview-skeleton'
import {
  LatestAudit,
  NO_AUDIT_ENTRIES,
  NO_PAID_ORDERS,
  RecentOrders,
} from '@/features/admin/components/overview/recent-orders'
import { healthItems } from '@/features/admin/lib/overview-health'
import { kpis } from '@/features/admin/lib/overview-kpis'
import type { AttentionCounts } from '@/features/admin/queries/attention'
import type { RecentOrder } from '@/features/admin/queries/overview'
import { floatState, minutesAgo, NOW, overview } from './fixtures'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const counts: AttentionCounts = {
  refunds: 2,
  jobs: 0,
  incidents: 0,
  alertsCritical: 1,
  alertsWarning: 2,
  drift: 0,
  stuckOrders: 3,
  pendingWithoutJob: 0,
  emailsFailed: 0,
  ledgerUnexplained: 0,
  presetDrafts: 0,
}

describe('HealthStrip', () => {
  it('gives each service a word beside its dot, with what it last saw', () => {
    const { health, float } = overview()
    render(
      <HealthStrip
        items={healthItems({ health, float, side: 'live', testOnly: false, now: NOW })}
      />,
    )
    const strip = screen.getByRole('region', { name: 'Health' })
    const gateway = within(strip).getByText('Gateway').closest('li')
    expect(gateway).not.toBeNull()
    expect(within(gateway as HTMLElement).getByText('OK')).toBeInTheDocument()
    expect(within(gateway as HTMLElement).getByText('Last seen 2 min ago')).toBeInTheDocument()
    expect(within(strip).getAllByRole('listitem')).toHaveLength(8)
    expect(
      within(strip).getByRole('link', { name: 'Every check, with its history' }),
    ).toHaveAttribute('href', '/admin/alerts?tab=health')
  })
})

describe('AttentionTiles', () => {
  it('puts each count inside its link, filtered to what was counted', () => {
    render(<AttentionTiles counts={counts} />)
    const region = screen.getByRole('region', { name: 'Needs a person' })
    expect(within(region).getByRole('link', { name: /^Stuck orders\s+3$/ })).toHaveAttribute(
      'href',
      '/admin/orders?stuck=1',
    )
    expect(
      within(region).getByRole('link', { name: /^Critical alerts\s+1\s+Plus 2 warnings$/ }),
    ).toHaveAttribute('href', '/admin/alerts?severity=critical')
    expect(within(region).getAllByRole('link')).toHaveLength(10)
    expect(
      within(region).getByText('Each tile opens its list, filtered to what is counted here.'),
    ).toBeInTheDocument()
  })

  it('says so when nothing needs a person', () => {
    const none = Object.fromEntries(Object.keys(counts).map((key) => [key, 0])) as AttentionCounts
    render(<AttentionTiles counts={none} />)
    expect(screen.getByText('Nothing needs a person on this side right now.')).toBeInTheDocument()
  })
})

describe('KpiRow', () => {
  it('marks the period in use with aria-current and a tick, not colour alone', () => {
    render(<KpiRow kpis={kpis(overview(), 7, NOW)} period={7} signups7d={3} />)
    const periods = screen.getByRole('navigation', { name: 'Sales period' })
    const week = within(periods).getByRole('link', { name: '7 days' })
    expect(week).toHaveAttribute('aria-current', 'true')
    expect(week.querySelector('svg')).not.toBeNull()
    expect(within(periods).getByRole('link', { name: '30 days' })).toHaveAttribute('href', '/admin')
    expect(within(periods).getByRole('link', { name: '30 days' })).not.toHaveAttribute(
      'aria-current',
    )
    expect(within(periods).getByRole('link', { name: '90 days' })).toHaveAttribute(
      'href',
      '/admin?period=90',
    )
  })

  it('links every figure, with the days it covers in its name', () => {
    render(<KpiRow kpis={kpis(overview(), 7, NOW)} period={7} signups7d={3} />)
    const sales = screen.getByRole('region', { name: 'Sales' })
    expect(
      within(sales).getByRole('link', { name: /^Cash in\s+₦10,750\s+Last 7 days$/ }),
    ).toHaveAttribute('href', '/admin/money?from=2026-09-26&to=2026-10-03')
    expect(
      within(sales).getByRole('link', { name: /^Registrations\s+4\s+Last 30 days$/ }),
    ).toBeInTheDocument()
    expect(within(sales).getByText('New accounts in the last 7 days:')).toBeInTheDocument()
  })
})

describe('FloatTiles', () => {
  it('shows the balance with its runway, and the 21-day target, both opening Supplier', () => {
    render(<FloatTiles float={floatState({ uncostedLines: 2 })} now={NOW} />)
    const float = screen.getByRole('region', { name: 'Supplier float' })
    const balance = within(float).getByRole('link', { name: /^Balance and runway/ })
    expect(balance).toHaveAttribute('href', '/admin/supplier')
    expect(balance).toHaveTextContent('$43.38')
    expect(balance).toHaveTextContent(
      "About 12 days at the last 7 days' spend (30-day pace: 14 days). Snapshot 09:50 WAT.",
    )
    expect(within(float).getByRole('link', { name: /^21-day target/ })).toHaveTextContent(
      'Keep $75.60 (21 days of spend); top up $32.22.',
    )
    expect(
      within(float).getByText(/2 paid lines are counted at today's prices\./),
    ).toBeInTheDocument()
  })

  it('says when there is no snapshot to show', () => {
    render(
      <FloatTiles
        float={floatState({ balanceCents: null, takenAt: null, topUpToTargetCents: null })}
        now={NOW}
      />,
    )
    expect(screen.getByRole('link', { name: /^Balance and runway/ })).toHaveTextContent(
      'Balance and runway — No balance snapshot on this side yet.',
    )
  })

  it('shows no target before the ledger has ever been read on the side', () => {
    render(
      <FloatTiles
        float={floatState({ balanceCents: null, burnState: 'stale', ledgerReadAt: null })}
        now={NOW}
      />,
    )
    expect(screen.getByRole('link', { name: /^21-day target/ })).toHaveTextContent(
      '21-day target — Not known until the supplier ledger has been read on this side.',
    )
  })
})

describe('OverviewCharts', () => {
  it('draws each chart as a named picture with its figures in a table', () => {
    render(<OverviewCharts overview={overview()} />)
    const pictures = screen.getAllByRole('img')
    expect(pictures.map((img) => img.getAttribute('aria-label'))).toEqual([
      'Net sales by day, last 30 days, in naira. The figures follow in a table.',
      "Supplier balance at each day's close, last 30 days, in US dollars. The figures follow in a table.",
      'Domains due to renew, by month, next 6 months. The figures follow in a table.',
      'Domains by status, demo domains left out. The figures follow in a table.',
    ])
    for (const img of pictures) {
      const table = img.closest('figure')?.querySelector('table.sr-only')
      expect(table).not.toBeNull()
    }
    const balance = screen.getByRole('table', {
      name: "Supplier balance at each day's close, last 30 days, in US dollars",
    })
    expect(within(balance).getByRole('row', { name: '2 Oct No data' })).toBeInTheDocument()
    expect(within(balance).getByRole('row', { name: '3 Oct $43.38' })).toBeInTheDocument()
    expect(screen.getByText(/dashed: the alert level, \$20\.00/)).toBeInTheDocument()
    expect(screen.getByText('Expiring in the next 30 days:')).toBeInTheDocument()
  })

  it('says so when a chart has nothing to draw', () => {
    render(
      <OverviewCharts
        overview={overview({
          balanceByDay: [{ day: '2026-10-03', closeCents: null }],
          domainsByStatus: [],
          float: floatState({ alertCents: null }),
        })}
      />,
    )
    expect(
      screen.getByText('No balance snapshots on this side in the last 30 days.'),
    ).toBeInTheDocument()
    expect(screen.getByText('No domains on this side yet.')).toBeInTheDocument()
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })
})

describe('RecentOrders', () => {
  const order: RecentOrder = {
    id: '0b6f3c4e-1d2a-4b5c-8d7e-9f0a1b2c3d4e',
    orderNumber: 'MDH-ABC123',
    status: 'completed',
    totalKobo: 2_150_000,
    paidAt: minutesAgo(60),
    invoiceNumber: 'TEST-INV-000012',
    testMode: true,
  }

  it('lists the latest paid orders, each linking to its page by id', () => {
    render(<RecentOrders orders={[order]} />)
    const table = screen.getByRole('table', { name: 'Latest paid orders' })
    const link = within(table).getByRole('link', { name: 'MDH-ABC123' })
    expect(link).toHaveAttribute('href', `/admin/orders/${order.id}`)
    expect(within(table).getByText('₦21,500')).toBeInTheDocument()
    expect(within(table).getByText('Completed')).toBeInTheDocument()
    expect(within(table).getByText('Test')).toBeInTheDocument()
    expect(within(table).getByText('3 Oct 2026, 09:00 WAT')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Every order' })).toHaveAttribute(
      'href',
      '/admin/orders',
    )
  })

  it('has an empty state, and an error state with a way on', () => {
    const { unmount } = render(<RecentOrders orders={[]} />)
    expect(screen.getByText(NO_PAID_ORDERS)).toBeInTheDocument()
    unmount()
    render(<RecentOrders orders={null} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("The latest orders couldn't be loaded.")
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('lists the latest audit entries, each linked to the log by number', () => {
    const entry = {
      id: 412,
      createdAt: '2026-10-03T09:00:00Z',
      adminLabel: 'e2e-ops',
      adminRole: 'operator',
      testActor: true,
      session: null,
      action: 'supplier.balance',
      side: 'test',
      targetType: 'supplier',
      targetId: 'test',
      targetTestMode: true,
      reason: null,
      redactedAt: null,
      outcome: 'intent',
      errorCode: null,
      detail: [],
      parentId: null,
      requestId: null,
      result: null,
    }
    render(
      <LatestAudit
        entries={[
          entry,
          { ...entry, id: 413, outcome: 'refused', errorCode: 'ROLE', action: 'refund.approve' },
        ]}
      />,
    )
    expect(screen.getByRole('link', { name: 'Open the audit log' })).toHaveAttribute(
      'href',
      '/admin/audit',
    )
    const list = screen.getByRole('list', { name: 'Latest audit entries' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByRole('link', { name: 'Entry #412' })).toHaveAttribute(
      'href',
      '/admin/audit?id=412',
    )
    expect(within(list).getByText('No result recorded')).toBeInTheDocument()
    expect(within(list).getByText('ROLE')).toBeInTheDocument()
    expect(within(list).getByText('Refused')).toBeInTheDocument()
  })

  it('says when nothing is recorded, or the log could not be read', () => {
    const { unmount } = render(<LatestAudit entries={[]} />)
    expect(screen.getByText(NO_AUDIT_ENTRIES)).toBeInTheDocument()
    unmount()
    render(<LatestAudit entries={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      "The latest audit entries couldn't be loaded.",
    )
  })
})

describe('the loading states', () => {
  it('are pulsing shapes, hidden from screen readers (S11)', () => {
    const { container } = render(
      <>
        <OverviewSkeleton />
        <BusinessSkeleton />
        <TilesSkeleton count={3} />
      </>,
    )
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(20)
    expect(screen.queryByRole('img')).toBeNull()
    for (const node of container.querySelectorAll('[aria-hidden="true"]')) {
      expect(node.textContent).toBe('')
    }
  })
})
