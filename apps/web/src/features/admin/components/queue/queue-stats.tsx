import { Panel } from '@/components/layout/panel'
import { StatTile } from '@/features/admin/components/stat-tile'
import { formatCount, formatWatDate } from '@/features/admin/lib/format'
import { JOB_KIND_LABEL, JOB_STATUS_LABEL, labelFor } from '@/features/admin/lib/labels'
import type { KindStatusCount, QueueStats } from '@/features/admin/queries/queue'

/** Room on the right for the tile's link arrow, so a long label wraps before it. */
const TILE = 'pr-10'

const COLUMNS = ['succeeded', 'queued', 'running', 'failed', 'needs_attention'] as const

type Row = { kind: string; counts: Record<string, number>; total: number }

/** Jobs made in the window, one row per kind, one column per status. */
export function byKind(counts: readonly KindStatusCount[]): Row[] {
  const rows = new Map<string, Row>()
  for (const { kind, status, count } of counts) {
    const row = rows.get(kind) ?? { kind, counts: {}, total: 0 }
    row.counts[status] = (row.counts[status] ?? 0) + count
    row.total += count
    rows.set(kind, row)
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind))
}

/**
 * What needs a person now, what the worker holds now, and the last 30 days
 * by kind (`admin_provisioning`) — each tile links to the list it counts.
 */
export function QueueStatsPanel({ stats }: { stats: QueueStats }) {
  const rows = byKind([...stats.last30.jobs, ...stats.last30.ssl])
  const caption = `Jobs made ${formatWatDate(`${stats.last30.from}T12:00:00Z`)} to ${formatWatDate(
    `${stats.last30.to}T12:00:00Z`,
  )}, by kind and where each is now`
  return (
    <Panel labelledBy="queue-stats-heading">
      <h2 id="queue-stats-heading" className="font-medium text-foreground">
        At a glance
      </h2>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Jobs needing a person"
          value={formatCount(stats.needsAttention.jobs)}
          href="/admin/queue?status=needs_attention"
          tone={stats.needsAttention.jobs > 0 ? 'danger' : 'neutral'}
          className={TILE}
        />
        <StatTile
          label="Certificate jobs needing a person"
          value={formatCount(stats.needsAttention.ssl)}
          href="/admin/queue/ssl-jobs?status=needs_attention"
          tone={stats.needsAttention.ssl > 0 ? 'danger' : 'neutral'}
          className={TILE}
        />
        <StatTile
          label="Jobs with the worker"
          value={formatCount(stats.open.jobs)}
          hint="Queued or running"
          href="/admin/queue?status=queued,running"
          tone={stats.open.jobs > 0 ? 'info' : 'neutral'}
          className={TILE}
        />
        <StatTile
          label="Certificate jobs with the worker"
          value={formatCount(stats.open.ssl)}
          hint="Queued or running"
          href="/admin/queue/ssl-jobs?status=queued,running"
          tone={stats.open.ssl > 0 ? 'info' : 'neutral'}
          className={TILE}
        />
      </div>

      <p id="queue-stats-window" className="mt-6 text-sm text-muted-foreground">
        {caption}
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No jobs were made in the last 30 days on this side.
        </p>
      ) : (
        <>
          {/* Phones: one line per kind, so nothing scrolls sideways. */}
          <ul
            aria-labelledby="queue-stats-window"
            className="mt-2 divide-y divide-border md:hidden"
          >
            {rows.map((row) => (
              <li key={row.kind} className="py-2 text-sm">
                <p className="font-medium text-foreground">{labelFor(JOB_KIND_LABEL, row.kind)}</p>
                <p className="text-muted-foreground tabular-nums">
                  {[
                    ...COLUMNS.filter((status) => (row.counts[status] ?? 0) > 0).map(
                      (status) =>
                        `${formatCount(row.counts[status] ?? 0)} ${labelFor(JOB_STATUS_LABEL, status).toLowerCase()}`,
                    ),
                    `${formatCount(row.total)} in all`,
                  ].join(' · ')}
                </p>
              </li>
            ))}
          </ul>
          <div className="relative mt-2 hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr className="border-border border-b text-left">
                  <th scope="col" className="py-2 pr-4 font-medium text-muted-foreground">
                    Kind
                  </th>
                  {COLUMNS.map((status) => (
                    <th
                      key={status}
                      scope="col"
                      className="px-2 py-2 text-right font-medium text-muted-foreground"
                    >
                      {labelFor(JOB_STATUS_LABEL, status)}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="py-2 pl-2 text-right font-medium text-muted-foreground"
                  >
                    All
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.kind} className="border-border border-b last:border-b-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal text-foreground">
                      {labelFor(JOB_KIND_LABEL, row.kind)}
                    </th>
                    {COLUMNS.map((status) => (
                      <td
                        key={status}
                        className="px-2 py-2 text-right text-foreground tabular-nums"
                      >
                        {formatCount(row.counts[status] ?? 0)}
                      </td>
                    ))}
                    <td className="py-2 pl-2 text-right font-medium text-foreground tabular-nums">
                      {formatCount(row.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}
