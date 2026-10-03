import { formatNaira } from '@dr/shared'
import { formatCount } from '@/features/admin/lib/format'
import type { LinesWindow, Overview, SalesWindow } from './overview-data'

/**
 * The overview's KPI row (docs/ADMIN-SPEC.md §5.2 B1, §6): sales over the
 * last 7, 30 or 90 days, from `admin_overview.sales`, and what was sold over
 * the same days, from `admin_overview.lines` (migration 42). Each figure
 * links to the page that breaks it down, over the same dates.
 */

export const PERIODS = [7, 30, 90] as const
export type Period = (typeof PERIODS)[number]
export const DEFAULT_PERIOD: Period = 30

/** `?period=7|30|90`; anything else is the default. */
export function parsePeriod(value: string | string[] | undefined): Period {
  const text = Array.isArray(value) ? value[0] : value
  const found = PERIODS.find((period) => String(period) === text)
  return found ?? DEFAULT_PERIOD
}

/** The overview at a period; the default leaves the URL bare. */
export function periodHref(period: Period): string {
  return period === DEFAULT_PERIOD ? '/admin' : `/admin?period=${period}`
}

export function periodLabel(period: Period): string {
  return `Last ${period} days`
}

const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Africa/Lagos',
})

/** `YYYY-MM-DD` in Lagos time — how the admin lists take `from` and `to`. */
export function watDay(date: Date): string {
  return LAGOS_DAY.format(date)
}

/** The days a period covers, as list filters: SQL's window starts `now − N days`. */
export function periodRange(period: Period, now: Date): { from: string; to: string } {
  return {
    from: watDay(new Date(now.getTime() - period * 86_400_000)),
    to: watDay(now),
  }
}

function href(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params).toString()}`
}

export type Kpi = {
  key: string
  label: string
  value: string
  /** Plain text, read with the link's name: the period the figure covers. */
  hint: string
  href: string
}

function window(overview: Overview, period: Period): SalesWindow {
  if (period === 7) return overview.sales.d7
  if (period === 90) return overview.sales.d90
  return overview.sales.d30
}

function linesIn(overview: Overview, period: Period): LinesWindow {
  if (period === 7) return overview.lines.d7
  if (period === 90) return overview.lines.d90
  return overview.lines.d30
}

/** The ten KPI tiles, in §5.2's order. */
export function kpis(overview: Overview, period: Period, now: Date): Kpi[] {
  const sales = window(overview, period)
  const lines = linesIn(overview, period)
  const range = periodRange(period, now)
  const money = href('/admin/money', range)
  const orders = (kind: string) => href('/admin/orders', { kind, ...range })
  const hint = periodLabel(period)

  return [
    { key: 'cash', label: 'Cash in', value: formatNaira(sales.cashKobo), hint, href: money },
    { key: 'net', label: 'Net sales', value: formatNaira(sales.netKobo), hint, href: money },
    { key: 'vat', label: 'VAT collected', value: formatNaira(sales.vatKobo), hint, href: money },
    {
      key: 'orders',
      label: 'Orders paid',
      value: formatCount(sales.ordersPaid),
      hint,
      href: href('/admin/orders', range),
    },
    {
      key: 'register',
      label: 'Registrations',
      value: formatCount(lines.register),
      hint,
      href: orders('register'),
    },
    {
      key: 'renew',
      label: 'Renewals',
      value: formatCount(lines.renew),
      hint,
      href: orders('renew'),
    },
    {
      key: 'transfer',
      label: 'Transfers in',
      value: formatCount(lines.transfer),
      hint,
      href: orders('transfer'),
    },
    {
      key: 'ssl',
      label: 'SSL sold',
      value: formatCount(lines.ssl),
      hint,
      href: orders('ssl'),
    },
    {
      key: 'lineRefunds',
      label: 'Line refunds',
      value: formatNaira(sales.lineRefundedKobo),
      hint,
      href: money,
    },
    {
      key: 'chargeRefunds',
      label: 'Charge refunds',
      value: formatNaira(sales.chargeRefundedKobo),
      hint,
      href: money,
    },
  ]
}
