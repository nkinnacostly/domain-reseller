import { Check } from 'lucide-react'
import Link from 'next/link'
import { FOCUS, PANEL_HEADING, Panel } from '@/components/layout/panel'
import { StatTile } from '@/features/admin/components/stat-tile'
import { formatCount } from '@/features/admin/lib/format'
import { type Kpi, PERIODS, type Period, periodHref } from '@/features/admin/lib/overview-kpis'
import { cn } from '@/lib/utils'
import { INNER_TILE } from './attention-tiles'

/**
 * Sales over a period (docs/ADMIN-SPEC.md §5.2 B1, §6). The period is in the
 * URL; the chosen one is marked with a tick and `aria-current`, not colour
 * alone (S8, S13). Every tile links to the page that breaks it down.
 */
export function KpiRow({
  kpis,
  period,
  signups7d,
}: {
  kpis: Kpi[]
  period: Period
  signups7d: number
}) {
  return (
    <Panel labelledBy="overview-sales-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="overview-sales-heading" className={PANEL_HEADING}>
          Sales
        </h2>
        <PeriodLinks period={period} />
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-3 min-[26rem]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {kpis.map((kpi) => (
          <li key={kpi.key} data-kpi={kpi.key} className="min-w-0">
            <StatTile
              label={kpi.label}
              value={kpi.value}
              hint={kpi.hint}
              href={kpi.href}
              className={`h-full ${INNER_TILE}`}
            />
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-muted-foreground">
        New accounts in the last 7 days:{' '}
        <span className="text-foreground tabular-nums">{formatCount(signups7d)}</span>
      </p>
    </Panel>
  )
}

export function PeriodLinks({ period }: { period: Period }) {
  return (
    <nav aria-label="Sales period">
      <ul className="flex flex-wrap gap-2">
        {PERIODS.map((value) => {
          const current = value === period
          return (
            <li key={value}>
              <Link
                href={periodHref(value)}
                scroll={false}
                aria-current={current ? 'true' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:font-semibold data-[current=true]:text-brand-foreground',
                  FOCUS,
                )}
              >
                {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {value} days
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
