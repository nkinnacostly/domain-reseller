import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { StatTile } from '@/features/admin/components/stat-tile'
import { formatCount } from '@/features/admin/lib/format'
import { parseSslListParams, type SslStatus, sslHref } from '@/features/admin/lib/ssl-params'
import type { Tone } from '@/features/admin/lib/tone'
import type { SslStats } from '@/features/admin/queries/ssl'

type Tile = {
  label: string
  value: number
  href: string
  tone: Tone
  hint?: string
}

const BASE = parseSslListParams({})
const byStatus = (status: SslStatus[]) => sslHref(BASE, { status })

/** The figures as tiles, each linking to the list it counts (`admin_ssl_stats`). */
export function sslTiles(stats: SslStats): Tile[] {
  const n = (status: SslStatus) => stats.byStatus[status] ?? 0
  const inProgress = n('pending') + n('setting_up') + n('reissuing')
  const ended = n('revoked') + n('cancelled')
  return [
    { label: 'Issued', value: n('issued'), href: byStatus(['issued']), tone: 'ok' },
    {
      label: 'Waiting for set-up',
      value: n('awaiting_setup'),
      href: byStatus(['awaiting_setup']),
      tone: 'info',
      hint: 'The customer sends it',
    },
    {
      label: 'Waiting for approval',
      value: n('awaiting_validation'),
      href: byStatus(['awaiting_validation']),
      tone: 'info',
      hint: 'The approver answers the CA',
    },
    {
      label: 'In progress',
      value: inProgress,
      href: byStatus(['pending', 'setting_up', 'reissuing']),
      tone: 'info',
      hint: 'Ordering, sending set-up or reissuing',
    },
    {
      label: 'Not ordered',
      value: n('failed'),
      href: byStatus(['failed']),
      tone: n('failed') > 0 ? 'danger' : 'neutral',
    },
    {
      label: 'Revoked or cancelled',
      value: ended,
      href: byStatus(['revoked', 'cancelled']),
      tone: 'neutral',
    },
    {
      label: 'Unknown supplier word',
      value: stats.unrecognised,
      href: sslHref(BASE, { unrecognised: true }),
      tone: stats.unrecognised > 0 ? 'warning' : 'neutral',
    },
    {
      label: 'Certificate jobs needing a person',
      value: stats.jobsNeedingPerson,
      href: '/admin/queue/ssl-jobs?status=needs_attention',
      tone: stats.jobsNeedingPerson > 0 ? 'danger' : 'neutral',
    },
  ]
}

export function SslStatsPanel({ stats }: { stats: SslStats }) {
  return (
    <Panel labelledBy="ssl-stats-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ssl-stats-heading" className={PANEL_HEADING}>
          At a glance
        </h2>
        <p className="text-sm text-muted-foreground">
          {formatCount(stats.total)} {stats.total === 1 ? 'certificate' : 'certificates'} ·{' '}
          {formatCount(stats.jobsOpen)} {stats.jobsOpen === 1 ? 'job' : 'jobs'} open
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {sslTiles(stats).map((tile) => (
          <li key={tile.label}>
            <StatTile
              label={tile.label}
              value={formatCount(tile.value)}
              href={tile.href}
              tone={tile.tone}
              {...(tile.hint ? { hint: tile.hint } : {})}
              className="h-full"
            />
          </li>
        ))}
      </ul>
    </Panel>
  )
}
