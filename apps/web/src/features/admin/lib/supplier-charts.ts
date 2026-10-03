import type { BarDatum } from '@/features/admin/components/charts/bar-chart'
import type { LineDatum } from '@/features/admin/components/charts/line-chart'
import { dayLabel } from './overview-charts'
import type { LedgerDay } from './supplier-data'

/**
 * The Supplier page's charts (docs/ADMIN-SPEC.md §5.2 B6): the balance at
 * each day's close over 90 days — the daily rollup (`metrics_daily`), with
 * today from the latest snapshot — and the mirror's settled debits and
 * credits per day (`admin_ledger_daily`). Every day of the range is a point:
 * a day with no ledger entry spent and received nothing (zero), while a day
 * with no close is a gap, never a made-up zero.
 */

export const CHART_DAYS = 90

/** Today's date in Lagos (WAT, UTC+1, no daylight saving), `YYYY-MM-DD`. */
export function lagosToday(now: Date): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** The last `count` Lagos days, oldest first, ending today. */
export function lagosDays(now: Date, count = CHART_DAYS): string[] {
  const end = new Date(`${lagosToday(now)}T12:00:00Z`)
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(end)
    day.setUTCDate(end.getUTCDate() - (count - 1 - index))
    return day.toISOString().slice(0, 10)
  })
}

/**
 * The close per day: the rollup's value, and for today — which the nightly
 * rollup has not reached — the latest snapshot when it was taken today.
 */
export function closeSeries(
  days: readonly string[],
  closes: readonly { day: string; closeCents: number }[],
  latest: { balanceCents: number | null | undefined; takenAt: string | null | undefined },
): LineDatum[] {
  const byDay = new Map(closes.map((row) => [row.day, row.closeCents]))
  const today = days.at(-1)
  if (
    today &&
    latest.takenAt &&
    latest.balanceCents !== null &&
    latest.balanceCents !== undefined &&
    lagosToday(new Date(latest.takenAt)) === today
  ) {
    byDay.set(today, latest.balanceCents)
  }
  return days.map((day) => ({ key: day, label: dayLabel(day), value: byDay.get(day) ?? null }))
}

export type LedgerSeries = { debits: BarDatum[]; credits: BarDatum[] }

export function ledgerSeries(days: readonly string[], rows: readonly LedgerDay[]): LedgerSeries {
  const byDay = new Map(rows.map((row) => [row.day, row]))
  return {
    debits: days.map((day) => ({
      key: day,
      label: dayLabel(day),
      value: byDay.get(day)?.debitCents ?? 0,
    })),
    credits: days.map((day) => ({
      key: day,
      label: dayLabel(day),
      value: byDay.get(day)?.creditCents ?? 0,
    })),
  }
}

/** True when a bar series has anything above zero to draw. */
export function hasActivity(series: readonly BarDatum[]): boolean {
  return series.some((d) => d.value > 0)
}
