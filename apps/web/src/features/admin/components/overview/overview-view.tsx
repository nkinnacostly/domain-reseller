import { Suspense } from 'react'
import { PanelHeader, PanelPage, PanelSkeleton } from '@/components/layout/panel'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import { healthItems } from '@/features/admin/lib/overview-health'
import { kpis, type Period, parsePeriod } from '@/features/admin/lib/overview-kpis'
import type { AdminSide } from '@/features/admin/lib/side'
import { getAttentionCounts } from '@/features/admin/queries/attention'
import { latestAuditEntries } from '@/features/admin/queries/audit'
import { getOverview, getRecentPaidOrders } from '@/features/admin/queries/overview'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { todayLine } from '@/features/domains/lib/dashboard'
import { AttentionTiles } from './attention-tiles'
import { FloatTiles } from './float-tiles'
import { HealthStrip } from './health-strip'
import { KpiRow } from './kpi-row'
import { OverviewCharts } from './overview-charts'
import { BusinessSkeleton, TilesSkeleton } from './overview-skeleton'
import { LatestAudit, RecentOrders } from './recent-orders'

export type OverviewSearch = Record<string, string | string[] | undefined>

/**
 * `/admin` — Operations (docs/ADMIN-SPEC.md §5.2 B1): health, what needs a
 * person, sales, the float, trends, the latest paid orders and the latest
 * audit entries, on the side
 * the admin is looking at. Read only: the page offers no actions. Each
 * section streams in on its own, with its own loading and error states (S11).
 */
export async function OverviewView({ searchParams }: { searchParams: Promise<OverviewSearch> }) {
  const admin = await requireAdmin()
  const [side, search] = await Promise.all([getAdminSide(admin), searchParams])
  const period = parsePeriod(search.period)
  // After the session's cookies are read, so the clock is this request's (CLAUDE.md §15).
  const now = new Date()

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin' }]}
        title="Operations"
        description={todayLine(now)}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      <Suspense fallback={<TilesSkeleton count={8} />}>
        <HealthSection side={side} testOnly={admin.testOnly} now={now} />
      </Suspense>
      <Suspense fallback={<TilesSkeleton count={10} />}>
        <AttentionSection side={side} />
      </Suspense>
      <Suspense fallback={<BusinessSkeleton />}>
        <BusinessSection side={side} period={period} now={now} />
      </Suspense>
      <Suspense fallback={<ListsSkeleton />}>
        <ListsSection admin={admin} side={side} />
      </Suspense>
    </PanelPage>
  )
}

export async function HealthSection({
  side,
  testOnly,
  now,
}: {
  side: AdminSide
  testOnly: boolean
  now: Date
}) {
  const overview = await getOverview(side)
  if (!overview) {
    return (
      <ErrorState
        title="Health couldn't be loaded."
        body="Nothing was changed. Try again; if it keeps failing, the alerts page lists each check."
      />
    )
  }
  return (
    <HealthStrip
      items={healthItems({ health: overview.health, float: overview.float, side, testOnly, now })}
    />
  )
}

export async function AttentionSection({ side }: { side: AdminSide }) {
  const counts = await getAttentionCounts(side)
  if (!counts) {
    return (
      <ErrorState
        title="What needs a person couldn't be counted."
        body="Nothing was changed. Try again; each list in the sidebar still opens on its own."
      />
    )
  }
  return <AttentionTiles counts={counts} />
}

export async function BusinessSection({
  side,
  period,
  now,
}: {
  side: AdminSide
  period: Period
  now: Date
}) {
  const overview = await getOverview(side)
  if (!overview) {
    return <ErrorState title="Sales, the float and the charts couldn't be loaded." />
  }
  return (
    <>
      <KpiRow kpis={kpis(overview, period, now)} period={period} signups7d={overview.signups7d} />
      <FloatTiles float={overview.float} now={now} />
      <OverviewCharts overview={overview} />
    </>
  )
}

export async function ListsSection({ admin, side }: { admin: AdminPrincipal; side: AdminSide }) {
  const [orders, audit] = await Promise.all([
    getRecentPaidOrders(admin, side),
    // A failed read shows its error state; the orders beside it still show.
    latestAuditEntries(admin, side).catch(() => null),
  ])
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:items-start">
      <RecentOrders orders={orders} />
      <LatestAudit entries={audit} />
    </div>
  )
}

function ListsSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
    >
      <TableSkeleton rows={5} />
      <PanelSkeleton height="h-40" />
    </div>
  )
}
