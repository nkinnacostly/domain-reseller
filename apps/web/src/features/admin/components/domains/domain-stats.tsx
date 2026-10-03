import Link from 'next/link'
import { STATUS_LABEL } from '@/components/common/domain-status-pill'
import { FOCUS, PANEL_HEADING, Panel } from '@/components/layout/panel'
import { StatTile } from '@/features/admin/components/stat-tile'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { DELEGATION_LABEL, renewalModeWords } from '@/features/admin/lib/domains-copy'
import {
  DELEGATION_STATES,
  type DelegationState,
  DOMAIN_STATUSES,
  type DomainStatus,
  filteredHref,
  LIVE_STATUSES,
} from '@/features/admin/lib/domains-params'
import { formatCount, formatWatDate } from '@/features/admin/lib/format'
import type { DomainStats } from '@/features/admin/queries/domains'
import { cn } from '@/lib/utils'

/**
 * The domains page's figures (`admin_domain_stats`, §5.2 B9). Demo rows are
 * left out, as the list leaves them out. Every count that is a filter links
 * to the list with that filter — and the same statuses the count was taken
 * over, so the list's total is the tile's figure.
 */

/** Room on the right for the tile's link arrow. */
const TILE = 'pr-10'

const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

const LIVE = [...LIVE_STATUSES] as DomainStatus[]

const isLive = (status: string) => (LIVE_STATUSES as readonly string[]).includes(status)

export type ExtensionRow = { tld: string; live: number; other: number }

/** One row per extension: the domains alive on it, and the rest. Most held first. */
export function byExtension(rows: DomainStats['byTldStatus']): ExtensionRow[] {
  const map = new Map<string, ExtensionRow>()
  for (const { tld, status, count } of rows) {
    const row = map.get(tld) ?? { tld, live: 0, other: 0 }
    if (isLive(status)) row.live += count
    else row.other += count
    map.set(tld, row)
  }
  return [...map.values()].sort(
    (a, b) => b.live - a.live || b.other - a.other || a.tld.localeCompare(b.tld),
  )
}

/** Each status's count across every extension, in lifecycle order. */
export function byStatus(rows: DomainStats['byTldStatus']): { status: string; count: number }[] {
  const totals = new Map<string, number>()
  for (const { status, count } of rows) totals.set(status, (totals.get(status) ?? 0) + count)
  const order = DOMAIN_STATUSES as readonly string[]
  return [...totals.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => {
      const ia = order.indexOf(a.status)
      const ib = order.indexOf(b.status)
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib)
    })
}

/** The extensions the side holds, for the filter's choices. */
export function statsTlds(stats: DomainStats | null): string[] {
  return stats ? [...new Set(stats.byTldStatus.map((row) => row.tld))].sort() : []
}

function delegationCount(stats: DomainStats, state: DelegationState): number {
  return stats.delegation.find((row) => row.status === state)?.count ?? 0
}

const EXTENSION_COLUMNS: Column<ExtensionRow>[] = [
  {
    key: 'tld',
    header: 'Extension',
    cell: (row) => (
      <Link href={filteredHref({ tld: row.tld })} className={LINK}>
        .{row.tld}
      </Link>
    ),
  },
  {
    key: 'live',
    header: 'Active, expired or in redemption',
    numeric: true,
    cell: (row) => formatCount(row.live),
  },
  {
    key: 'other',
    header: 'Any other status',
    numeric: true,
    cell: (row) => formatCount(row.other),
  },
]

export function DomainStatsPanel({ stats }: { stats: DomainStats }) {
  const statuses = byStatus(stats.byTldStatus)
  const held = statuses.filter((row) => isLive(row.status)).reduce((sum, row) => sum + row.count, 0)
  const { expiries } = stats
  const failing = delegationCount(stats, 'failed')
  const extensions = byExtension(stats.byTldStatus)

  return (
    <Panel labelledBy="domains-stats-heading" className="space-y-6">
      <h2 id="domains-stats-heading" className={PANEL_HEADING}>
        At a glance
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="Active, expired or in redemption"
          value={formatCount(held)}
          href={filteredHref({ status: LIVE })}
          className={TILE}
        />
        <StatTile
          label="Past their expiry"
          value={formatCount(expiries.expired)}
          hint="Expired or in redemption, not renewed"
          href={filteredHref({ status: LIVE, expires: 'expired' })}
          tone={expiries.expired > 0 ? 'warning' : 'neutral'}
          className={TILE}
        />
        <StatTile
          label="Expiring within 30 days"
          value={formatCount(expiries.d30)}
          hint={`${formatCount(expiries.d60)} within 60 days`}
          href={filteredHref({ status: LIVE, expires: '30' })}
          tone={expiries.d30 > 0 ? 'warning' : 'neutral'}
          className={TILE}
        />
        <StatTile
          label="Expiring within 90 days"
          value={formatCount(expiries.d90)}
          hint={`${formatCount(expiries.autoOn90)} with auto-renew on, ${formatCount(expiries.autoOff90)} off`}
          href={filteredHref({ status: LIVE, expires: '90' })}
          className={TILE}
        />
        <StatTile
          label="Next expiry"
          value={expiries.next ? formatWatDate(expiries.next) : 'None'}
          hint={expiries.next ? undefined : 'Nothing expires from now on'}
        />
        <StatTile
          label="Nameservers not working in DNS"
          value={formatCount(failing)}
          href={filteredHref({ status: LIVE, delegation: 'failed' })}
          tone={failing > 0 ? 'danger' : 'neutral'}
          className={TILE}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="domains-by-status-heading" className="min-w-0 space-y-3">
          <h3 id="domains-by-status-heading" className="text-sm font-medium text-foreground">
            By status
          </h3>
          {statuses.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {statuses.map((row) => (
                <li key={row.status}>
                  <Link
                    href={
                      (DOMAIN_STATUSES as readonly string[]).includes(row.status)
                        ? filteredHref({ status: [row.status as DomainStatus] })
                        : '/admin/domains'
                    }
                    className={cn(
                      'inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition hover:bg-brand-subtle active:scale-[0.98]',
                      FOCUS,
                    )}
                  >
                    {STATUS_LABEL[row.status as DomainStatus] ?? row.status.replace(/_/g, ' ')}{' '}
                    <span className="tabular-nums text-muted-foreground">
                      {formatCount(row.count)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No domains on this side yet.</p>
          )}

          <h3 className="pt-3 text-sm font-medium text-foreground">
            Nameservers in DNS (active, expired or in redemption)
          </h3>
          <ul className="grid gap-1 text-sm">
            {DELEGATION_STATES.map((state) => (
              <li key={state} className="flex justify-between gap-4">
                <Link
                  href={filteredHref({ status: LIVE, delegation: state })}
                  className={cn(LINK, 'inline-flex min-h-11 items-center')}
                >
                  {DELEGATION_LABEL[state]}
                </Link>
                <span className="self-center tabular-nums text-foreground">
                  {formatCount(delegationCount(stats, state))}
                </span>
              </li>
            ))}
          </ul>

          <h3 className="pt-3 text-sm font-medium text-foreground">At the registry</h3>
          {stats.registryAutoRenewLabel.length > 0 ? (
            <ul className="grid gap-2 text-sm text-muted-foreground">
              {stats.registryAutoRenewLabel.map((row) => (
                <li key={row.mode ?? 'unknown'} className="flex justify-between gap-4">
                  <span className="min-w-0 text-pretty">{renewalModeWords(row.mode)}</span>
                  <span className="shrink-0 tabular-nums text-foreground">
                    {formatCount(row.count)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No active domain has been read from the registry yet.
            </p>
          )}
        </section>

        <section aria-labelledby="domains-by-extension-heading" className="min-w-0 space-y-3">
          <h3 id="domains-by-extension-heading" className="text-sm font-medium text-foreground">
            By extension
          </h3>
          <DataTable
            caption="Domains by extension"
            rows={extensions}
            columns={EXTENSION_COLUMNS}
            rowKey={(row) => row.tld}
            empty={<p className="text-sm text-muted-foreground">No domains on this side yet.</p>}
          />
        </section>
      </div>
    </Panel>
  )
}
