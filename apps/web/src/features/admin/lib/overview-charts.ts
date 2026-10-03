import type { BarDatum } from '@/features/admin/components/charts/bar-chart'
import type { LineDatum } from '@/features/admin/components/charts/line-chart'
import type { Overview } from './overview-data'

/**
 * The overview's four charts as series (docs/ADMIN-SPEC.md §5.2 B1): net
 * sales by day, the balance at each day's close, renewals due by month and
 * domains by status — each straight from `admin_overview`, labelled for the
 * table that sits beside every chart for screen readers (§5.3).
 */

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })

/** SQL's Lagos dates (`YYYY-MM-DD`) are calendar days: read at noon UTC, shown as is. */
function calendar(day: string): Date | null {
  const date = new Date(`${day.slice(0, 10)}T12:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "3 Oct". */
export function dayLabel(day: string): string {
  const date = calendar(day)
  return date ? DAY.format(date) : day
}

/** "Oct 2026". */
export function monthLabel(month: string): string {
  const date = calendar(month)
  return date ? MONTH.format(date) : month
}

/** A domain status in words, from the panel's own labels; an unknown one as itself. */
export function domainStatusLabel(labels: Record<string, string>, status: string): string {
  return labels[status] ?? status.replace(/_/g, ' ')
}

export type OverviewSeries = {
  revenue: BarDatum[]
  balance: LineDatum[]
  renewals: BarDatum[]
  statuses: BarDatum[]
}

export function overviewSeries(
  overview: Pick<Overview, 'revenueByDay' | 'balanceByDay' | 'renewalsByMonth' | 'domainsByStatus'>,
  statusLabels: Record<string, string>,
): OverviewSeries {
  return {
    revenue: overview.revenueByDay.map((d) => ({
      key: d.day,
      label: dayLabel(d.day),
      value: d.netKobo,
    })),
    balance: overview.balanceByDay.map((d) => ({
      key: d.day,
      label: dayLabel(d.day),
      value: d.closeCents ?? null,
    })),
    renewals: overview.renewalsByMonth.map((m) => ({
      key: m.month,
      label: monthLabel(m.month),
      value: m.count,
    })),
    statuses: overview.domainsByStatus.map((s) => ({
      key: s.status,
      label: domainStatusLabel(statusLabels, s.status),
      value: s.count,
    })),
  }
}

/** True when a series has nothing to draw: no point is known. */
export function hasPoints(series: readonly { value: number | null }[]): boolean {
  return series.some((d) => d.value !== null)
}
