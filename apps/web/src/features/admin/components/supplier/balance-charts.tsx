import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { BarChart } from '@/features/admin/components/charts/bar-chart'
import { LineChart } from '@/features/admin/components/charts/line-chart'
import { ErrorState } from '@/features/admin/components/error-state'
import { formatUsd } from '@/features/admin/lib/format'
import { hasPoints } from '@/features/admin/lib/overview-charts'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  CHART_DAYS,
  closeSeries,
  hasActivity,
  lagosDays,
  ledgerSeries,
} from '@/features/admin/lib/supplier-charts'
import type { AdminPrincipal } from '@/features/admin/queries/session'
import {
  getBalanceCloses,
  getLedgerDaily,
  getSupplierFloat,
} from '@/features/admin/queries/supplier'

/**
 * The float's trends (docs/ADMIN-SPEC.md §5.2 B6): the balance at each day's
 * close over 90 days with a dashed alert line, and the ledger's settled
 * debits and credits per day. Server-rendered SVG, each a named picture with
 * its figures in a table for screen readers (§5.3).
 */
export async function BalanceCharts({
  admin,
  side,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  now: Date
}) {
  const days = lagosDays(now, CHART_DAYS)
  const first = days[0] as string
  const last = days.at(-1) as string
  const [float, closes, ledger] = await Promise.all([
    getSupplierFloat(side),
    getBalanceCloses(admin, side, first),
    getLedgerDaily(side, first, last),
  ])
  if (!closes || !ledger) {
    return <ErrorState title="The balance charts couldn't be loaded." />
  }
  const balance = closeSeries(days, closes, {
    balanceCents: float?.balanceCents,
    takenAt: float?.takenAt,
  })
  const { debits, credits } = ledgerSeries(days, ledger)
  const alertCents = float?.alertCents ?? null

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ChartPanel id="supplier-chart-close" heading="Balance at each day's close">
        {hasPoints(balance) ? (
          <LineChart
            title="Supplier balance at each day's close, last 90 days, in US dollars"
            data={balance}
            format={formatUsd}
            {...(alertCents === null
              ? {}
              : {
                  threshold: {
                    value: alertCents,
                    label: `the alert level, ${formatUsd(alertCents)}`,
                  },
                })}
          />
        ) : (
          <ChartEmpty words="No balance closes on this side in the last 90 days." />
        )}
      </ChartPanel>
      <ChartPanel id="supplier-chart-ledger" heading="Ledger debits and credits">
        {hasActivity(debits) || hasActivity(credits) ? (
          <div className="grid gap-6">
            <BarChart
              title="Settled supplier debits by day, last 90 days, in US dollars"
              data={debits}
              format={formatUsd}
            />
            <BarChart
              title="Credits (top-ups) by day, last 90 days, in US dollars"
              data={credits}
              format={formatUsd}
            />
          </div>
        ) : (
          <ChartEmpty words="No settled ledger entries on this side in the last 90 days." />
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
