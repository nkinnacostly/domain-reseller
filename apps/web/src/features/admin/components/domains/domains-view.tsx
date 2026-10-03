import type { LocalStatus } from '@dr/shared'
import { Info } from 'lucide-react'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { DomainName } from '@/components/common/domain-name'
import { DomainStatusPill } from '@/components/common/domain-status-pill'
import { FOCUS, PANEL_HEADING, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import {
  DELEGATION_LABEL,
  DELEGATION_TONE,
  DOMAINS_DESCRIPTION,
  EMAIL_REFUSED,
  LIST_ERROR,
  NO_DOMAINS,
  NO_MATCH,
  registryStatusWords,
  STATS_ERROR,
  settingWords,
  sideWord,
  UNKNOWN_SEARCH,
} from '@/features/admin/lib/domains-copy'
import {
  type DelegationState,
  type DomainListParams,
  type DomainSort,
  domainsHref,
  isFiltered,
  parseDomainListParams,
} from '@/features/admin/lib/domains-params'
import { ago, formatCount, formatWatDate, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  type DomainList,
  type DomainListRow,
  type DomainStats,
  getDomainStats,
  listDomains,
} from '@/features/admin/queries/domains'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { DomainStatsPanel, statsTlds } from './domain-stats'
import {
  DomainSortLinks,
  DomainStatusChips,
  DomainsFilterForm,
  DomainsSearch,
} from './domains-filters'

type Search = Record<string, string | string[] | undefined>

const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

/** "Demo" beside a demo row, in words: it was never at a registry. */
export function DemoBadge() {
  return (
    <span className="inline-flex h-5 items-center rounded-md border border-border bg-muted px-1.5 text-[0.6875rem] font-medium text-foreground">
      Demo
    </span>
  )
}

/** Nameservers in public DNS, in words with its tone. */
export function DelegationPill({ state }: { state: string | null }) {
  if (!state) return <span className="text-muted-foreground">—</span>
  const known = state as DelegationState
  return (
    <AdminStatusPill
      value={state}
      labels={DELEGATION_LABEL}
      tone={DELEGATION_TONE[known] ?? 'neutral'}
      // The words are long for a phone's card: they wrap rather than widen the page (S6).
      className="h-auto min-h-6 shrink py-0.5 whitespace-normal"
    />
  )
}

/** The account that holds it, by id — never by email (N13). */
export function AccountLink({ userId }: { userId: string | null }) {
  if (!userId) return <span className="text-muted-foreground">—</span>
  return (
    <Link href={adminHref.customer(userId)} className={LINK}>
      Account {shortId(userId)}
    </Link>
  )
}

/** A notice above the list: what was not done, and why. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex gap-2.5 rounded-xl border border-border bg-background/80 px-3.5 py-3 text-sm/6 text-foreground"
    >
      <Info className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 text-pretty">{children}</div>
    </div>
  )
}

export function domainColumns(now: Date): Column<DomainListRow, DomainSort>[] {
  return [
    {
      key: 'domain',
      header: 'Domain',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link
            href={adminHref.domain(row.id)}
            className={cn(LINK, 'font-medium break-all')}
            data-domain-link={row.id}
          >
            <DomainName name={row.name} />
          </Link>
          {row.testMode ? <TestBadge /> : null}
          {row.source === 'demo' ? <DemoBadge /> : null}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (row.status ? <DomainStatusPill status={row.status as LocalStatus} /> : '—'),
    },
    {
      key: 'expires',
      header: 'Expires',
      sort: 'expires',
      cell: (row) =>
        row.expiresAt ? (
          <span>
            <span className="whitespace-nowrap">{formatWatDate(row.expiresAt)}</span>{' '}
            <span className="whitespace-nowrap text-muted-foreground">
              ({ago(row.expiresAt, now)})
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">No expiry yet</span>
        ),
    },
    { key: 'renew', header: 'Auto-renew', cell: (row) => settingWords(row.autoRenew) },
    {
      key: 'lock',
      header: 'Transfer lock',
      cell: (row) => settingWords(row.transferLock, row.pendingTransferLock),
    },
    {
      key: 'privacy',
      header: 'Privacy',
      cell: (row) => settingWords(row.privacy, row.pendingPrivacy),
    },
    {
      key: 'dns',
      header: 'Nameservers in DNS',
      cell: (row) => <DelegationPill state={row.delegation} />,
    },
    {
      key: 'registry',
      header: 'Registry',
      sort: 'checked',
      cell: (row) =>
        row.registryCheckedAt ? (
          <span>
            {registryStatusWords(row.registryStatus)}{' '}
            <span className="whitespace-nowrap text-muted-foreground">
              ({formatWatDate(row.registryCheckedAt)})
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">Not read yet</span>
        ),
    },
    { key: 'account', header: 'Account', cell: (row) => <AccountLink userId={row.userId} /> },
    {
      key: 'added',
      header: 'Added',
      sort: 'added',
      cell: (row) => <span className="whitespace-nowrap">{formatWatDate(row.createdAt)}</span>,
    },
  ]
}

/** The list itself, its notices and its four states (S11). */
export function DomainsList({
  side,
  params,
  list,
  now,
}: {
  side: AdminSide
  params: DomainListParams
  list: DomainList | null
  now: Date
}) {
  if (params.search.kind === 'email' || params.search.kind === 'unknown') {
    return (
      <Notice>
        <p>{params.search.kind === 'email' ? EMAIL_REFUSED : UNKNOWN_SEARCH}</p>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {params.search.kind === 'email' ? (
            <Link href="/admin/customers" className={cn(LINK, 'underline')}>
              Go to Customers
            </Link>
          ) : null}
          <Link href={domainsHref(params, { q: '' })} className={cn(LINK, 'underline')}>
            Show domains without a search
          </Link>
        </p>
      </Notice>
    )
  }
  if (!list) return <ErrorState title={LIST_ERROR} />

  const pages = pageCount(list.total, params.per)
  let body: React.ReactNode
  if (list.total === 0) {
    body = isFiltered(params) ? (
      <EmptyState
        title={NO_MATCH}
        body="Change or clear the filters to see more."
        action={
          <Link href="/admin/domains" className={QUIET_BUTTON}>
            Clear all filters
          </Link>
        }
      />
    ) : (
      <EmptyState
        title={NO_DOMAINS(side)}
        body={
          side === 'test'
            ? 'Test domains appear here once a test order is registered in the sandbox.'
            : 'Domains appear here as customers register or transfer them in.'
        }
      />
    )
  } else if (list.rows.length === 0) {
    body = (
      <EmptyState
        title={`Nothing on page ${params.page}.`}
        body={`The list has ${pages} ${pages === 1 ? 'page' : 'pages'}.`}
        action={
          <Link href={domainsHref(params, { page: 1 })} className={QUIET_BUTTON}>
            Go to the first page
          </Link>
        }
      />
    )
  } else {
    body = (
      <DataTable<DomainListRow, DomainSort>
        caption={`Domains on the ${sideWord(side)} side, page ${params.page} of ${pages}`}
        rows={list.rows}
        columns={domainColumns(now)}
        rowKey={(row) => row.id}
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => domainsHref(params, nextSort(params, sort)),
        }}
        empty={null}
      />
    )
  }

  return (
    <div className="space-y-3">
      <DomainSortLinks params={params} />
      {body}
      {list.total > 0 ? (
        <Pager
          page={params.page}
          pageCount={pages}
          total={list.total}
          href={(page) => domainsHref(params, { page })}
        />
      ) : null}
    </div>
  )
}

const settled = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null)

/** `/admin/domains` (B9): the figures, the filters, then the list. */
export async function DomainsView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const params = parseDomainListParams(await searchParams)
  const now = new Date()
  const searchable = params.search.kind !== 'email' && params.search.kind !== 'unknown'
  const [list, stats] = await Promise.all([
    searchable ? settled(listDomains(admin, side, params, now)) : Promise.resolve(null),
    settled<DomainStats>(getDomainStats(side)),
  ])

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Domains' }]}
        title="Domains"
        description={DOMAINS_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      {stats ? <DomainStatsPanel stats={stats} /> : <ErrorState title={STATS_ERROR} />}
      <Panel labelledBy="domains-find-heading" className="space-y-4">
        <h2 id="domains-find-heading" className={PANEL_HEADING}>
          Find domains
        </h2>
        <DomainsSearch params={params} />
        <DomainStatusChips params={params} />
        <DomainsFilterForm params={params} tlds={statsTlds(stats)} />
      </Panel>
      <section aria-labelledby="domains-list-heading" className="space-y-3">
        <h2 id="domains-list-heading" className="px-1 font-medium text-foreground">
          {list && searchable
            ? `${formatCount(list.total)} ${list.total === 1 ? 'domain' : 'domains'}`
            : 'Domains'}
        </h2>
        <DomainsList side={side} params={params} list={list} now={now} />
      </section>
    </PanelPage>
  )
}
