import type { LocalStatus } from '@dr/shared'
import Link from 'next/link'
import { DomainName } from '@/components/common/domain-name'
import { DomainStatusPill } from '@/components/common/domain-status-pill'
import { FOCUS, PANEL_HEADING, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { DlGrid, type DlItem } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Timeline, type TimelineEvent } from '@/features/admin/components/timeline'
import { type AdminRole, canAct } from '@/features/admin/lib/actions'
import { driftKindLabel } from '@/features/admin/lib/alerts-copy'
import {
  countryWords,
  DEEP_SYNC,
  DETAIL_ERROR,
  deepSyncOffer,
  expiryWords,
  gatewayStale,
  nameserverWords,
  REGISTRY,
  registrantTypeWords,
  renewalModeWords,
  SECTION_ERROR,
  SOURCE_LABEL,
  settingWords,
  sideWord,
} from '@/features/admin/lib/domains-copy'
import { type DomainSource, parseDomainId } from '@/features/admin/lib/domains-params'
import { formatWat, formatWatDate, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { JOB_KIND_LABEL, JOB_STATUS_LABEL, labelFor } from '@/features/admin/lib/labels'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  type DomainDetail,
  type DomainDrift,
  type DomainJob,
  getDomain,
  type NameserverChange,
  type Section,
} from '@/features/admin/queries/domains'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { DeepSyncButton } from './deep-sync'
import { AccountLink, DelegationPill, DemoBadge } from './domains-view'
import { RegistrantPanel } from './registrant'
import { RegistryCompare, VerificationRead } from './registry-reads'

/**
 * One domain (docs/ADMIN-SPEC.md §5.2 B9): our record beside the
 * registry's, the registrant's summary (the rest only on an audited reveal),
 * registry drift, nameserver history, jobs and the timeline. The page never
 * asks the registry by itself (D10): the live reads are buttons.
 */

const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

export type Viewer = { role: AdminRole; testOnly: boolean }

const sentence = (value: string) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ') : value

/** A domain this side does not hold: the link is wrong, or it is on the other side. */
export function DomainNotFound({ side }: { side: AdminSide }) {
  return (
    <EmptyState
      title={`This domain isn't on the ${sideWord(side)} side.`}
      body="It may be on the other side — switch sides above — or the link may be wrong."
      action={
        <Link href="/admin/domains" className={LINK}>
          Back to domains
        </Link>
      }
    />
  )
}

function SectionPanel({
  id,
  title,
  children,
  aside,
}: {
  id: string
  title: string
  children: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <Panel labelledBy={`${id}-heading`} className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${id}-heading`} className={PANEL_HEADING}>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </Panel>
  )
}

/** A section's rows, or its own error state with "Try again" (S11). */
function Part<T>({
  section,
  children,
}: {
  section: Section<T>
  children: (data: T) => React.ReactNode
}) {
  if (!section.ok) return <ErrorState title={SECTION_ERROR} />
  return <>{children(section.data)}</>
}

function summary(detail: DomainDetail, now: Date): DlItem[] {
  const { domain } = detail
  const line = detail.line.ok ? detail.line.data : null
  const preset = detail.preset.ok ? detail.preset.data : null
  const items: DlItem[] = [
    {
      label: 'Status',
      value: domain.status ? <DomainStatusPill status={domain.status as LocalStatus} /> : '—',
    },
    {
      label: 'Expires',
      value: domain.expiresAt ? (
        <>
          {formatWatDate(domain.expiresAt)}{' '}
          <span className="text-muted-foreground">({expiryWords(domain.expiresAt, now)})</span>
        </>
      ) : (
        'No expiry yet'
      ),
    },
    { label: 'Registered', value: formatWatDate(domain.registeredAt) },
    { label: 'Auto-renew', value: settingWords(domain.autoRenew) },
    {
      label: 'Transfer lock',
      value: settingWords(domain.transferLock, domain.pendingTransferLock),
    },
    { label: 'Privacy', value: settingWords(domain.privacy, domain.pendingPrivacy) },
    {
      label: 'Nameservers',
      value: (
        <span className="break-all">
          {nameserverWords(domain.nameservers)}
          {domain.pendingNameservers && domain.pendingNameservers.length > 0 ? (
            <span className="block text-sm text-muted-foreground">
              Changing to {nameserverWords(domain.pendingNameservers)}
            </span>
          ) : null}
        </span>
      ),
      wide: true,
    },
    {
      label: 'Host preset',
      value: preset ? (
        <Link href={adminHref.preset(preset.id)} className={LINK}>
          {preset.provider}
        </Link>
      ) : domain.presetId ? (
        `Preset ${shortId(domain.presetId)}`
      ) : (
        'None — typed by hand or the registrar’s default'
      ),
    },
    {
      label: 'Nameservers in DNS',
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <DelegationPill state={domain.delegation} />
          {domain.delegationCheckedAt ? (
            <span className="text-sm text-muted-foreground">
              checked {formatWat(domain.delegationCheckedAt)}
            </span>
          ) : null}
        </span>
      ),
    },
    { label: 'Account', value: <AccountLink userId={domain.userId} /> },
    {
      label: 'Order',
      value: line ? (
        <Link href={adminHref.order(line.orderId)} className={LINK}>
          {line.orderNumber ?? `Order ${shortId(line.orderId)}`}
        </Link>
      ) : domain.orderItemId ? (
        `Line ${shortId(domain.orderItemId)}`
      ) : (
        'None'
      ),
    },
    { label: 'Added', value: formatWat(domain.createdAt) },
    { label: 'Updated', value: formatWat(domain.updatedAt) },
  ]
  return items
}

function DeepSyncPanel({
  detail,
  viewer,
  now,
  returnTo,
}: {
  detail: DomainDetail
  viewer: Viewer
  now: Date
  returnTo: string
}) {
  const { domain, gateway } = detail
  const side: AdminSide = domain.testMode ? 'test' : 'live'
  const offer = deepSyncOffer(domain)
  const mayQueue = canAct(viewer, 'domain.deep_sync')
  return (
    <SectionPanel id="domain-deep-sync" title="Deep sync">
      <p className="text-sm/6 text-foreground">
        {domain.deepCheckedAt ? DEEP_SYNC.last(domain.deepCheckedAt) : DEEP_SYNC.waiting}
      </p>
      {offer.offered ? (
        <>
          {gateway.kind === 'hidden' ? (
            <p className="max-w-2xl text-sm/6 text-muted-foreground">{DEEP_SYNC.gatewayHidden}</p>
          ) : gateway.kind === 'read' && gatewayStale(gateway.beatAt, now) ? (
            <p role="status" className="max-w-2xl text-sm/6 font-medium text-foreground">
              {DEEP_SYNC.noGateway(side)}
            </p>
          ) : null}
          {mayQueue ? (
            <DeepSyncButton domainId={domain.id} name={domain.name} returnTo={returnTo} />
          ) : (
            <p className="text-sm text-muted-foreground">{DEEP_SYNC.roleOnly}</p>
          )}
        </>
      ) : (
        <p className="max-w-2xl text-sm/6 text-muted-foreground">{offer.words}</p>
      )}
    </SectionPanel>
  )
}

const DRIFT_COLUMNS: Column<DomainDrift>[] = [
  { key: 'kind', header: 'What differs', cell: (row) => driftKindLabel(row.kind) },
  {
    key: 'state',
    header: 'State',
    cell: (row) =>
      row.resolvedAt ? (
        <AdminStatusPill value="resolved" labels={{ resolved: 'Resolved' }} tone="neutral" />
      ) : (
        <AdminStatusPill value="open" labels={{ open: 'Open' }} tone="warning" />
      ),
  },
  { key: 'ours', header: 'Ours', cell: (row) => row.ours },
  { key: 'registry', header: 'Registry', cell: (row) => row.registry },
  { key: 'first', header: 'First seen', cell: (row) => formatWat(row.firstSeenAt) },
  {
    key: 'last',
    header: 'Last seen',
    cell: (row) =>
      row.resolvedAt ? `Resolved ${formatWat(row.resolvedAt)}` : formatWat(row.lastSeenAt),
  },
]

const HISTORY_COLUMNS: Column<NameserverChange>[] = [
  { key: 'when', header: 'Changed', cell: (row) => formatWat(row.changedAt) },
  {
    key: 'before',
    header: 'From',
    cell: (row) => (
      <span className="break-all">{row.before ? nameserverWords(row.before) : '—'}</span>
    ),
  },
  {
    key: 'after',
    header: 'To',
    cell: (row) => <span className="break-all">{nameserverWords(row.after)}</span>,
  },
]

const JOB_COLUMNS: Column<DomainJob>[] = [
  {
    key: 'job',
    header: 'Job',
    cell: (row) => (
      <Link href={adminHref.job(row.id)} className={LINK}>
        {labelFor(JOB_KIND_LABEL, row.kind)}
      </Link>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <AdminStatusPill value={row.status} labels={JOB_STATUS_LABEL} />,
  },
  {
    key: 'error',
    header: 'Last error',
    cell: (row) =>
      row.lastErrorCode ? <code className="font-mono text-xs">{row.lastErrorCode}</code> : '—',
  },
  { key: 'attempts', header: 'Attempts', numeric: true, cell: (row) => row.attempts },
  { key: 'made', header: 'Made', cell: (row) => formatWat(row.createdAt) },
]

function timeline(detail: DomainDetail): TimelineEvent[] {
  if (!detail.events.ok) return []
  return detail.events.data.map((event) => ({
    id: `event-${event.id}`,
    at: event.createdAt,
    title: sentence(event.eventType),
    detail: event.actorType === 'system' ? undefined : `By ${event.actorType}`,
  }))
}

export function DomainDetailBody({
  detail,
  side,
  viewer,
  now,
}: {
  detail: DomainDetail
  side: AdminSide
  viewer: Viewer
  now: Date
}) {
  const { domain } = detail
  const returnTo = adminHref.domain(domain.id)
  const source = SOURCE_LABEL[domain.source as DomainSource] ?? domain.source ?? '—'
  const openDrift = detail.drift.ok
    ? detail.drift.data.filter((row) => row.resolvedAt === null).length
    : 0

  return (
    <>
      <PanelHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Domains', href: '/admin/domains' },
          { label: 'Domain' },
        ]}
        title={
          <span className="break-all">
            <DomainName name={domain.name} />
          </span>
        }
        titleAside={
          <span className="inline-flex flex-wrap items-center gap-2">
            {domain.status ? <DomainStatusPill status={domain.status as LocalStatus} /> : null}
            {domain.testMode ? <TestBadge /> : null}
            {domain.source === 'demo' ? <DemoBadge /> : null}
          </span>
        }
        description={`${source}${domain.tld ? ` · .${domain.tld}` : ''} · domain ${shortId(domain.id)}`}
        actions={<SideSwitch side={side} testOnly={viewer.testOnly} />}
      />

      <SectionPanel id="domain-summary" title="Summary">
        <DlGrid items={summary(detail, now)} />
      </SectionPanel>

      <SectionPanel id="domain-registry" title="Ours and the registry">
        <RegistryCompare
          name={domain.name}
          ours={{
            status: domain.status,
            expiresAt: domain.expiresAt,
            transferLock: domain.transferLock,
            privacy: domain.privacy,
            nameservers: domain.nameservers,
          }}
          stored={{ registryStatus: domain.registryStatus, checkedAt: domain.registryCheckedAt }}
          readOff={
            domain.source === 'demo'
              ? DEEP_SYNC.demo
              : canAct(viewer, 'supplier.domain_lookup')
                ? undefined
                : REGISTRY.roleOnly
          }
          returnTo={returnTo}
        />
        <p className="max-w-2xl text-sm/6 text-muted-foreground">
          {renewalModeWords(domain.registryRenewalMode)}.
        </p>
      </SectionPanel>

      <SectionPanel id="domain-registrant" title="Registrant">
        <RegistrantPanel
          domainId={domain.id}
          name={domain.name}
          country={countryWords(domain.registrantCountry)}
          type={registrantTypeWords(domain.registrantType)}
          hasRegistrant={domain.registrantType !== null}
          canReveal={canAct(viewer, 'domain.reveal_contacts')}
          returnTo={returnTo}
        />
        <section aria-labelledby="domain-verification-heading" className="space-y-3 pt-2">
          <h3 id="domain-verification-heading" className="text-sm font-medium text-foreground">
            Registrant verification
          </h3>
          {domain.source === 'demo' ? (
            <p className="text-sm text-muted-foreground">{DEEP_SYNC.demo}</p>
          ) : (
            <VerificationRead
              name={domain.name}
              canRead={canAct(viewer, 'supplier.verification')}
              returnTo={returnTo}
            />
          )}
        </section>
      </SectionPanel>

      <DeepSyncPanel detail={detail} viewer={viewer} now={now} returnTo={returnTo} />

      <SectionPanel
        id="domain-drift"
        title="Registry drift"
        aside={
          openDrift > 0 ? (
            <Link href="/admin/alerts?tab=drift" className={cn(LINK, 'text-sm')}>
              All open drift
            </Link>
          ) : null
        }
      >
        <Part section={detail.drift}>
          {(rows) => (
            <DataTable
              caption="Registry drift for this domain, newest first"
              rows={rows}
              columns={DRIFT_COLUMNS}
              rowKey={(row) => String(row.id)}
              empty={
                <p className="text-sm text-muted-foreground">
                  The registry checks have found nothing different for this domain.
                </p>
              }
            />
          )}
        </Part>
      </SectionPanel>

      <SectionPanel id="domain-history" title="Nameserver history">
        <Part section={detail.history}>
          {(rows) => (
            <DataTable
              caption="Nameserver changes, newest first"
              rows={rows}
              columns={HISTORY_COLUMNS}
              rowKey={(row) => String(row.id)}
              empty={
                <p className="text-sm text-muted-foreground">
                  The nameservers haven't changed since this domain was added.
                </p>
              }
            />
          )}
        </Part>
      </SectionPanel>

      <SectionPanel
        id="domain-jobs"
        title="Jobs"
        aside={
          detail.jobs.ok && detail.jobs.data.total > detail.jobs.data.rows.length ? (
            <Link href={`/admin/queue?domain=${domain.id}`} className={cn(LINK, 'text-sm')}>
              All {detail.jobs.data.total} jobs
            </Link>
          ) : null
        }
      >
        <Part section={detail.jobs}>
          {(jobs) => (
            <DataTable
              caption="Jobs for this domain, newest first"
              rows={jobs.rows}
              columns={JOB_COLUMNS}
              rowKey={(row) => row.id}
              empty={<p className="text-sm text-muted-foreground">No jobs for this domain.</p>}
            />
          )}
        </Part>
      </SectionPanel>

      <SectionPanel id="domain-timeline" title="Timeline">
        <Part section={detail.events}>
          {() => (
            <Timeline events={timeline(detail)} empty="Nothing recorded for this domain yet." />
          )}
        </Part>
      </SectionPanel>
    </>
  )
}

/** `/admin/domains/[id]` (B9). */
export async function DomainView({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const id = parseDomainId((await params).id)
  const now = new Date()
  const detail = id
    ? await getDomain(admin, side, id).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      )
    : { ok: true as const, value: null }

  const header = (
    <PanelHeader
      crumbs={[
        { label: 'Admin', href: '/admin' },
        { label: 'Domains', href: '/admin/domains' },
        { label: 'Domain' },
      ]}
      title="Domain"
      actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
    />
  )

  return (
    <PanelPage>
      {!detail.ok ? (
        <>
          {header}
          <ErrorState title={DETAIL_ERROR} />
        </>
      ) : detail.value ? (
        <DomainDetailBody detail={detail.value} side={side} viewer={admin} now={now} />
      ) : (
        <>
          {header}
          <DomainNotFound side={side} />
        </>
      )}
    </PanelPage>
  )
}
