import Link from 'next/link'
import { FOCUS, PANEL, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { CopyValue } from '@/features/admin/components/copy-value'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import { canAct } from '@/features/admin/lib/actions'
import { formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { pageCount } from '@/features/admin/lib/list-params'
import {
  INCIDENT_KIND_LABEL,
  INCIDENT_KIND_MEANING,
  naira,
} from '@/features/admin/lib/refunds-copy'
import {
  INCIDENT_KINDS,
  type IncidentListParams,
  incidentsHref,
  isOwedIncident,
  outcomesFor,
  parseIncidentParams,
  toggled,
} from '@/features/admin/lib/refunds-rules'
import {
  countOpenIncidents,
  getRefundStats,
  type IncidentRow,
  listIncidents,
} from '@/features/admin/queries/refunds'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { QUIET_LINK, RefundsTabs } from './parts'
import { needPersonCount } from './refunds-view'
import { ResolveIncident } from './resolve-incident'

/**
 * /admin/refunds/incidents (ADMIN-SPEC §5.2 B3): charges that could not be
 * applied to an order, until a person resolves them — unresolved first, by
 * default. Each card links from a Telegram alert by its anchor
 * (`#incident-<id>`, adminHref.incident).
 */

type Search = Record<string, string | string[] | undefined>

const LINK = cn('rounded text-foreground underline underline-offset-4', FOCUS)

const STATE_CHIPS = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
]

/** An incident's recorded facts (amounts, statuses and codes only), as label and words. */
function detailEntries(detail: Record<string, unknown>): [string, string][] {
  return Object.entries(detail).flatMap(([key, value]): [string, string][] => {
    const label = key.replace(/_/g, ' ')
    if (typeof value === 'number' && key.endsWith('_kobo')) return [[label, naira(value)]]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [[label, String(value)]]
    }
    return []
  })
}

function IncidentCard({ incident, admin }: { incident: IncidentRow; admin: AdminPrincipal }) {
  const headingId = `incident-${incident.id}-heading`
  const owed = isOwedIncident(incident.kind)
  const canResolve = canAct(admin, owed ? 'incident.resolve_money' : 'incident.resolve')
  const facts = detailEntries(incident.detail)
  return (
    <li id={`incident-${incident.id}`} className={cn(PANEL, 'scroll-mt-4 space-y-4 p-5 sm:p-6')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="font-medium text-foreground">
          {INCIDENT_KIND_LABEL[incident.kind] ?? incident.kind.replace(/_/g, ' ')}
        </h3>
        <AdminStatusPill
          value={incident.resolvedAt ? 'resolved' : 'open'}
          labels={{ open: 'Open', resolved: 'Resolved' }}
          tone={incident.resolvedAt ? 'ok' : owed ? 'danger' : 'warning'}
        />
        {owed ? <span className="text-xs font-medium text-foreground">Money owed</span> : null}
        {incident.testMode ? <TestBadge /> : null}
      </div>
      {INCIDENT_KIND_MEANING[incident.kind] ? (
        <p className="max-w-3xl text-sm text-muted-foreground">
          {INCIDENT_KIND_MEANING[incident.kind]}
        </p>
      ) : null}
      <DlGrid
        items={[
          {
            label: 'Order',
            value: incident.orderId ? (
              <Link href={adminHref.order(incident.orderId)} className={LINK}>
                {incident.orderNumber ?? 'Open the order'}
              </Link>
            ) : (
              'No order'
            ),
          },
          {
            label: 'Charge',
            value: incident.providerReference ? (
              <CopyValue value={incident.providerReference} label="charge id" />
            ) : (
              '—'
            ),
          },
          { label: 'Noted', value: formatWat(incident.createdAt) },
          {
            label: 'Resolved',
            value: incident.resolvedAt
              ? `${formatWat(incident.resolvedAt)}${incident.resolvedBy ? ` by ${incident.resolvedBy}` : ''}`
              : 'Not yet',
          },
        ]}
      />
      {facts.length > 0 ? (
        <details className="text-sm">
          <summary
            className={cn('inline-flex min-h-11 cursor-pointer items-center rounded', FOCUS)}
          >
            What was recorded
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {incident.resolvedAt ? null : canResolve ? (
        <ResolveIncident
          incident={{
            id: incident.id,
            kind: incident.kind,
            owed,
            orderNumber: incident.orderNumber,
            providerReference: incident.providerReference,
            completedRefunds: incident.completedRefunds,
          }}
          outcomes={owed ? outcomesFor(incident.kind, admin) : []}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Your admin role can view incidents only. An operator or the owner resolves them.
        </p>
      )}
    </li>
  )
}

export async function IncidentsView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const params: IncidentListParams = parseIncidentParams(await searchParams)
  const [list, openIncidents, stats] = await Promise.all([
    listIncidents(admin, side, params),
    countOpenIncidents(admin, side),
    getRefundStats(side),
  ])
  const sideWord = side === 'test' ? 'Test' : 'Live'
  const filtered = params.state !== 'open' || params.kinds.length > 0 || params.id !== null

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Refunds', href: '/admin/refunds' },
          { label: 'Payment incidents' },
        ]}
        title="Payment incidents"
        description="Charges that could not be applied to an order as they came in. Each stays open until a person resolves it; where money is owed, the database checks what settled it."
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      >
        <RefundsTabs needPerson={needPersonCount(stats)} openIncidents={openIncidents} />
      </PanelHeader>

      <Panel labelledBy="incident-filters-heading" className="space-y-4">
        <h2 id="incident-filters-heading" className="font-medium text-foreground">
          Show
        </h2>
        <FilterChips
          label="Resolved or not"
          chips={STATE_CHIPS}
          selected={params.state === 'all' ? [] : [params.state]}
          href={(value) =>
            incidentsHref(params, { state: value === 'resolved' ? 'resolved' : 'open' })
          }
          allHref={incidentsHref(params, { state: 'all' })}
        />
        <FilterChips
          label="Kind"
          chips={INCIDENT_KINDS.map((kind) => ({
            value: kind,
            label: INCIDENT_KIND_LABEL[kind] ?? kind,
          }))}
          selected={params.kinds}
          href={(value) => incidentsHref(params, { kinds: toggled(params.kinds, value) })}
          allHref={incidentsHref(params, { kinds: [] })}
        />
        {params.id !== null ? (
          <p
            data-testid="incident-id-filter"
            className="flex flex-wrap items-center gap-x-3 text-sm text-foreground"
          >
            <span>Incident #{params.id} only, resolved or not.</span>
            <Link
              href={incidentsHref(params, { id: null })}
              className={cn(LINK, 'inline-flex min-h-11 items-center hover:no-underline')}
            >
              Show every incident
            </Link>
          </p>
        ) : null}
      </Panel>

      {list.ok ? (
        list.rows.length === 0 ? (
          <EmptyState
            title={
              filtered
                ? 'No incidents match these filters'
                : `No open payment incidents on the ${sideWord} side`
            }
            body={
              filtered
                ? 'Clear a filter to see more.'
                : 'Every charge that came in was applied to its order, or has been resolved.'
            }
            action={
              filtered ? (
                <Link href="/admin/refunds/incidents" className={QUIET_LINK}>
                  Show open incidents
                </Link>
              ) : undefined
            }
          />
        ) : (
          <section aria-labelledby="incident-list-heading" className="space-y-4">
            <h2 id="incident-list-heading" className="sr-only">
              Incidents
            </h2>
            <ul aria-label={`Payment incidents, ${sideWord} side`} className="space-y-4">
              {list.rows.map((incident) => (
                <IncidentCard key={incident.id} incident={incident} admin={admin} />
              ))}
            </ul>
            <Pager
              page={params.page}
              pageCount={pageCount(list.total, params.per)}
              total={list.total}
              href={(page) => incidentsHref(params, { page })}
            />
          </section>
        )
      ) : (
        <ErrorState title="The payment incidents couldn't be loaded." />
      )}
    </PanelPage>
  )
}
