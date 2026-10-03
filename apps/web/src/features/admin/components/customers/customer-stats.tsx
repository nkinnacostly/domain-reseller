import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { BarChart } from '@/features/admin/components/charts/bar-chart'
import { ErrorState } from '@/features/admin/components/error-state'
import { StatTile } from '@/features/admin/components/stat-tile'
import {
  SIGNUPS_TITLE,
  STATS_ERROR,
  STATS_HEADING,
  STATS_HIDDEN,
  STATS_HIDDEN_BODY,
  STATS_NOTE,
} from '@/features/admin/lib/customers-copy'
import { formatCount, formatWatDate } from '@/features/admin/lib/format'
import type { StatsResult } from '@/features/admin/queries/customers'

/**
 * The account totals (`admin_customer_stats`, §5.2 B8): real accounts, live
 * side. A test admin is told they are not shown, and SQL is not asked.
 */
export function CustomerStatsPanel({ result }: { result: StatsResult }) {
  return (
    <Panel labelledBy="customer-stats-heading" className="space-y-4">
      <h2 id="customer-stats-heading" className={PANEL_HEADING}>
        {STATS_HEADING}
      </h2>
      <StatsBody result={result} />
    </Panel>
  )
}

function StatsBody({ result }: { result: StatsResult }) {
  if (result.kind === 'hidden') {
    return (
      <div>
        <p className="font-medium text-foreground">{STATS_HIDDEN}</p>
        <p className="mt-1 text-sm text-muted-foreground">{STATS_HIDDEN_BODY}</p>
      </div>
    )
  }
  if (result.kind === 'error') return <ErrorState title={STATS_ERROR} />

  const { stats } = result
  const tiles = [
    { label: 'Accounts', value: stats.profiles },
    { label: 'Email confirmed', value: stats.confirmed },
    { label: 'Bought on the live side', value: stats.liveBuyers },
    { label: 'Holding live domains', value: stats.holders },
    { label: 'Two-factor on', value: stats.mfaUsers },
    { label: 'Signed in, last 30 days', value: stats.active30d },
  ]
  return (
    <>
      <p className="text-sm text-muted-foreground">{STATS_NOTE}</p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.label}>
            <StatTile label={tile.label} value={formatCount(tile.value)} />
          </li>
        ))}
        <li>
          <StatTile
            label="Over 10 live domains, no two-factor"
            value={formatCount(stats.over10NoMfa)}
            hint="They must turn it on before ordering or transferring in another domain."
            tone={stats.over10NoMfa > 0 ? 'warning' : 'neutral'}
          />
        </li>
      </ul>
      {stats.signupsByDay.length > 0 ? (
        <BarChart
          title={SIGNUPS_TITLE}
          data={stats.signupsByDay.map((day) => ({
            key: day.day,
            label: formatWatDate(`${day.day}T12:00:00Z`),
            value: day.count,
          }))}
          format={(value) => formatCount(value)}
          className="max-w-2xl"
        />
      ) : null}
    </>
  )
}
