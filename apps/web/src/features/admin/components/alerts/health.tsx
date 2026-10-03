import { Suspense } from 'react'
import { PanelSkeleton } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { StatTile } from '@/features/admin/components/stat-tile'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import {
  CRON_STATUS_LABEL,
  cronTone,
  formatSeconds,
  HEARTBEATS_HIDDEN,
  HEARTBEATS_HIDDEN_TITLE,
  heartbeatLabel,
  ledgerHeartbeatName,
  OUTCOME_LABEL,
  outcomeTone,
} from '@/features/admin/lib/alerts-copy'
import { ago, formatCount } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import {
  type CronJob,
  getAlertStats,
  getCronHealth,
  getReconcileRuns,
  type Heartbeat,
  listHeartbeats,
  RUN_DAYS,
  type RunRow,
} from '@/features/admin/queries/alerts'
import type { AdminPrincipal, AdminSide } from '@/features/admin/queries/session'
import { AlertsNote, AlertsSection, SeenAt } from './alert-parts'

/**
 * Whether the background work is running (ADMIN-SPEC §5.2, B5): each
 * service's last heartbeat, the registry checks of the last week, the host
 * presets' health and — for a real admin only — the scheduled jobs. Each
 * part loads and fails on its own.
 */

const SIDE_WORD: Record<AdminSide, string> = { live: 'Live', test: 'Test' }

function heartbeatColumns(now: Date): Column<Heartbeat>[] {
  return [
    { key: 'service', header: 'Service', cell: (row) => heartbeatLabel(row.name) },
    { key: 'side', header: 'Side', cell: (row) => SIDE_WORD[row.side] },
    { key: 'beat', header: 'Last heartbeat', cell: (row) => <SeenAt at={row.beatAt} now={now} /> },
    {
      key: 'outcome',
      header: 'Last outcome',
      cell: (row) =>
        row.outcome ? (
          <AdminStatusPill
            value={row.outcome}
            labels={OUTCOME_LABEL}
            tone={outcomeTone(row.outcome)}
          />
        ) : (
          <span className="text-muted-foreground">Not recorded</span>
        ),
    },
  ]
}

async function ServiceHeartbeats({
  admin,
  side,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  now: Date
}) {
  const result = await listHeartbeats(admin, side)
  if (result.ok && 'hidden' in result) {
    return <EmptyState title={HEARTBEATS_HIDDEN_TITLE} body={HEARTBEATS_HIDDEN} />
  }
  if (!result.ok) return <ErrorState title="The service heartbeats couldn't be loaded." />
  const ledger = result.data.find((row) => row.name === ledgerHeartbeatName(side))
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatTile
          label={`Supplier ledger last read (${SIDE_WORD[side]})`}
          value={ledger ? ago(ledger.beatAt, now) : 'Never'}
          hint={
            ledger
              ? `Outcome: ${ledger.outcome ? (OUTCOME_LABEL[ledger.outcome] ?? ledger.outcome) : 'not recorded'}`
              : 'No ledger sync has run on this side.'
          }
          tone={ledger ? outcomeTone(ledger.outcome) : 'warning'}
        />
      </div>
      <DataTable
        caption="Service heartbeats"
        rows={result.data}
        rowKey={(row) => row.name}
        columns={heartbeatColumns(now)}
        empty={
          <EmptyState
            title="No heartbeats yet"
            body="A heartbeat appears when the gateway or a scheduled sync first runs."
          />
        }
      />
    </div>
  )
}

function runColumns(now: Date): Column<RunRow>[] {
  return [
    { key: 'started', header: 'Started', cell: (row) => <SeenAt at={row.startedAt} now={now} /> },
    {
      key: 'length',
      header: 'Took',
      numeric: true,
      cell: (row) => formatSeconds(row.seconds),
    },
    {
      key: 'seen',
      header: 'Domains read',
      numeric: true,
      cell: (row) => formatCount(row.domainsSeen),
    },
    {
      key: 'findings',
      header: 'Findings',
      numeric: true,
      cell: (row) => formatCount(row.findings),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (row) => (
        <AdminStatusPill
          value={row.outcome.label}
          labels={{ [row.outcome.label]: row.outcome.label }}
          tone={row.outcome.tone}
        />
      ),
    },
  ]
}

async function RegistryChecks({
  admin,
  side,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  now: Date
}) {
  const result = await getReconcileRuns(admin, side, now)
  if (!result.ok) return <ErrorState title="The registry checks couldn't be loaded." />
  const { runs, failed, averageSeconds, recent } = result.data
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label={`Checks, last ${RUN_DAYS} days`} value={formatCount(runs)} />
        <StatTile
          label="Checks that failed"
          value={formatCount(failed)}
          tone={failed > 0 ? 'danger' : 'neutral'}
        />
        <StatTile label="Average check" value={formatSeconds(averageSeconds)} />
      </div>
      <DataTable
        caption={`The last ${recent.length} registry checks`}
        rows={recent}
        rowKey={(row) => row.id}
        columns={runColumns(now)}
        empty={
          <EmptyState
            title={`No registry checks on this side in the last ${RUN_DAYS} days`}
            body="The gateway reads the registry hourly for the side it writes to. A side no gateway writes to is not checked."
          />
        }
      />
    </div>
  )
}

async function PresetHealth({ side }: { side: AdminSide }) {
  const stats = await getAlertStats(side, RUN_DAYS)
  const presets = stats.ok ? stats.data.presets : null
  if (!presets) return <ErrorState title="The host presets' health couldn't be loaded." />
  const href = adminHref.preset(null)
  return (
    <div className="space-y-3">
      <AlertsNote>
        Host presets have no side: these counts are the same on Live and Test.
      </AlertsNote>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Hidden from customers"
          value={formatCount(presets.hidden)}
          href={href}
          tone={presets.hidden > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Failing their DNS check"
          value={formatCount(presets.failing)}
          href={href}
          tone={presets.failing > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Not re-verified in 90 days"
          value={formatCount(presets.stale)}
          href={href}
          tone={presets.stale > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Drafts waiting"
          value={formatCount(presets.drafts)}
          href={href}
          tone={presets.drafts > 0 ? 'info' : 'neutral'}
        />
      </div>
    </div>
  )
}

function cronColumns(now: Date): Column<CronJob>[] {
  return [
    {
      key: 'job',
      header: 'Job',
      cell: (row) => <code className="font-mono text-sm break-all">{row.job}</code>,
    },
    {
      key: 'schedule',
      header: 'Schedule',
      cell: (row) =>
        row.schedule ? <code className="font-mono text-sm">{row.schedule}</code> : '—',
    },
    { key: 'last', header: 'Last run', cell: (row) => <SeenAt at={row.lastRunAt} now={now} /> },
    {
      key: 'status',
      header: 'Last status',
      cell: (row) =>
        row.lastStatus ? (
          <AdminStatusPill
            value={row.lastStatus}
            labels={CRON_STATUS_LABEL}
            tone={cronTone(row.lastStatus)}
          />
        ) : (
          <span className="text-muted-foreground">Never run</span>
        ),
    },
    {
      key: 'success',
      header: 'Last success',
      cell: (row) => <SeenAt at={row.lastSuccessAt} now={now} />,
    },
  ]
}

async function ScheduledJobs({
  admin,
  side,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  now: Date
}) {
  const result = await getCronHealth(admin, side)
  if (result.ok && 'hidden' in result) return null
  if (!result.ok) return <ErrorState title="The scheduled jobs couldn't be loaded." />
  return (
    <DataTable
      caption="Scheduled jobs"
      rows={result.data}
      rowKey={(row) => row.job}
      columns={cronColumns(now)}
      empty={
        <EmptyState
          title="No scheduled jobs"
          body="pg_cron lists no jobs. The migrations schedule them; check the database's cron schema."
        />
      }
    />
  )
}

export function HealthTab({
  admin,
  side,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  now: Date
}) {
  return (
    <div className="space-y-8">
      <AlertsSection id="health-services-heading" title="Background services">
        <Suspense fallback={<PanelSkeleton height="h-48" />}>
          <ServiceHeartbeats admin={admin} side={side} now={now} />
        </Suspense>
      </AlertsSection>
      <AlertsSection id="health-registry-heading" title="Registry checks">
        <Suspense fallback={<PanelSkeleton height="h-48" />}>
          <RegistryChecks admin={admin} side={side} now={now} />
        </Suspense>
      </AlertsSection>
      <AlertsSection id="health-presets-heading" title="Host presets">
        <Suspense fallback={<PanelSkeleton height="h-32" />}>
          <PresetHealth side={side} />
        </Suspense>
      </AlertsSection>
      {/* §5.2: a test administrator sees no cron panel; SQL leaves it out for one too. */}
      {admin.testOnly ? null : (
        <AlertsSection id="health-cron-heading" title="Scheduled jobs">
          <Suspense fallback={<PanelSkeleton height="h-48" />}>
            <ScheduledJobs admin={admin} side={side} now={now} />
          </Suspense>
        </AlertsSection>
      )}
    </div>
  )
}
