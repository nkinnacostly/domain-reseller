import { formatNaira } from '@dr/shared'
import { STATUS_LABEL } from '@/components/common/domain-status-pill'
import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { BarChart } from '@/features/admin/components/charts/bar-chart'
import { LineChart } from '@/features/admin/components/charts/line-chart'
import { formatCount, formatUsd } from '@/features/admin/lib/format'
import { hasPoints, overviewSeries } from '@/features/admin/lib/overview-charts'
import type { Overview } from '@/features/admin/lib/overview-data'

/**
 * The overview's trends (docs/ADMIN-SPEC.md §5.2 B1): server-rendered SVG,
 * each a named picture with its figures in a table for screen readers
 * (§5.3). A chart with nothing to draw says so instead.
 */
export function OverviewCharts({
  overview,
}: {
  overview: Pick<
    Overview,
    'revenueByDay' | 'balanceByDay' | 'renewalsByMonth' | 'domainsByStatus' | 'expiries30d'
  > & { float: Pick<Overview['float'], 'alertCents'> }
}) {
  const series = overviewSeries(overview, STATUS_LABEL)
  const alertCents = overview.float.alertCents
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ChartPanel id="overview-chart-sales" heading="Net sales">
        <BarChart
          title="Net sales by day, last 30 days, in naira"
          data={series.revenue}
          format={formatNaira}
        />
      </ChartPanel>

      <ChartPanel id="overview-chart-balance" heading="Supplier balance">
        {hasPoints(series.balance) ? (
          <LineChart
            title="Supplier balance at each day's close, last 30 days, in US dollars"
            data={series.balance}
            format={formatUsd}
            threshold={
              alertCents === null || alertCents === undefined
                ? undefined
                : { value: alertCents, label: `the alert level, ${formatUsd(alertCents)}` }
            }
          />
        ) : (
          <ChartEmpty words="No balance snapshots on this side in the last 30 days." />
        )}
      </ChartPanel>

      <ChartPanel id="overview-chart-renewals" heading="Renewals due">
        <BarChart
          title="Domains due to renew, by month, next 6 months"
          data={series.renewals}
          format={formatCount}
        />
        <p className="mt-3 text-sm text-muted-foreground">
          Expiring in the next 30 days:{' '}
          <span className="text-foreground tabular-nums">{formatCount(overview.expiries30d)}</span>
        </p>
      </ChartPanel>

      <ChartPanel id="overview-chart-statuses" heading="Domains by status">
        {series.statuses.length > 0 ? (
          <BarChart
            title="Domains by status, demo domains left out"
            data={series.statuses}
            format={formatCount}
          />
        ) : (
          <ChartEmpty words="No domains on this side yet." />
        )}
      </ChartPanel>
    </div>
  )
}

function ChartPanel({
  id,
  heading,
  children,
}: {
  id: string
  heading: string
  children: React.ReactNode
}) {
  return (
    <Panel labelledBy={id} className="min-w-0">
      <h2 id={id} className={PANEL_HEADING}>
        {heading}
      </h2>
      {/* relative + overflow-hidden: a chart's figures are an sr-only table, and a
          table is never narrower than its cells, so unclipped it widened a 320px
          page (S5, S6). Clipped, a screen reader still reads every row. */}
      <div className="relative mt-4 overflow-hidden">{children}</div>
    </Panel>
  )
}

function ChartEmpty({ words }: { words: string }) {
  return (
    <p className="rounded-2xl border border-border border-dashed bg-background/70 px-4 py-10 text-center text-sm text-muted-foreground">
      {words}
    </p>
  )
}
