import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { PANEL_HEADING, Panel, PanelHeader, PanelPage } from '@/components/layout/panel'
import { TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import { formatCount } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  EMAIL_REFUSED,
  expiryWords,
  LIST_ERROR,
  NO_CERTIFICATES,
  NO_CERTIFICATES_BODY,
  NO_MATCH,
  PAID_ERROR,
  PAID_HEADING,
  PAID_NONE,
  PAID_NOTE,
  SSL_DESCRIPTION,
  STATS_ERROR,
  sideWord,
  supplierWordText,
  UNKNOWN_SEARCH,
} from '@/features/admin/lib/ssl-copy'
import {
  isSslFiltered,
  parseSslListParams,
  type SslListParams,
  type SslSort,
  sslHref,
} from '@/features/admin/lib/ssl-params'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import {
  type CertificateList,
  type CertificateRow,
  getSslStats,
  listCertificates,
  listPaidWithoutCertificate,
  type PaidLine,
  type SslStats,
} from '@/features/admin/queries/ssl'
import { cn } from '@/lib/utils'
import { SslFilterForm, SslSearch, SslSortLinks, SslStatusChips } from './ssl-filters'
import { AccountLink, CertificatePill, LINK, Notice, When } from './ssl-parts'
import { SslStatsPanel } from './ssl-stats'

type Search = Record<string, string | string[] | undefined>

export function certificateColumns(now: Date): Column<CertificateRow, SslSort>[] {
  return [
    {
      key: 'name',
      header: 'Certificate',
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link href={adminHref.certificate(row.id)} className={cn(LINK, 'font-medium break-all')}>
            {row.commonName}
          </Link>
          {row.testMode ? <TestBadge /> : null}
        </span>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      cell: (row) => row.productName ?? row.productCode ?? '—',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <CertificatePill status={row.status} expiresAt={row.expiresAt} now={now} />,
    },
    {
      key: 'supplier',
      header: 'DomainNameAPI says',
      cell: (row) => supplierWordText(row.supplierStatus, row.unrecognisedSince),
    },
    {
      key: 'ordered',
      header: 'Ordered',
      sort: 'ordered',
      cell: (row) => <When at={row.createdAt} />,
    },
    {
      key: 'expires',
      header: 'Expires',
      sort: 'expires',
      cell: (row) => expiryWords(row.expiresAt, now),
    },
    {
      key: 'checked',
      header: 'Last checked',
      sort: 'checked',
      cell: (row) => <When at={row.lastCheckedAt} none="Not yet" />,
    },
    { key: 'customer', header: 'Customer', cell: (row) => <AccountLink userId={row.userId} /> },
  ]
}

/** The list itself, its notices and its four states (S11). */
export function CertificateListBody({
  side,
  params,
  list,
  now,
}: {
  side: AdminSide
  params: SslListParams
  /** null: the read failed. */
  list: CertificateList | null
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
          <Link href={sslHref(params, { q: '' })} className={cn(LINK, 'underline')}>
            Show certificates without a search
          </Link>
        </p>
      </Notice>
    )
  }
  if (!list) return <ErrorState title={LIST_ERROR} />

  const pages = pageCount(list.total, params.per)
  let body: React.ReactNode
  if (list.total === 0) {
    body = isSslFiltered(params) ? (
      <EmptyState
        title={NO_MATCH}
        body="Change or clear the filters to see more."
        action={
          <Link href="/admin/ssl" className={QUIET_BUTTON}>
            Clear all filters
          </Link>
        }
      />
    ) : (
      <EmptyState title={NO_CERTIFICATES(side)} body={NO_CERTIFICATES_BODY(side)} />
    )
  } else if (list.rows.length === 0) {
    body = (
      <EmptyState
        title={`Nothing on page ${params.page}.`}
        body={`The list has ${pages} ${pages === 1 ? 'page' : 'pages'}.`}
        action={
          <Link href={sslHref(params, { page: 1 })} className={QUIET_BUTTON}>
            Go to the first page
          </Link>
        }
      />
    )
  } else {
    body = (
      <DataTable<CertificateRow, SslSort>
        caption={`Certificates on the ${sideWord(side)} side, page ${params.page} of ${pages}`}
        rows={list.rows}
        columns={certificateColumns(now)}
        rowKey={(row) => row.id}
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => sslHref(params, nextSort(params, sort)),
        }}
        empty={null}
      />
    )
  }

  return (
    <div className="space-y-3">
      <SslSortLinks params={params} />
      {body}
      {list.total > 0 ? (
        <Pager
          page={params.page}
          pageCount={pages}
          total={list.total}
          href={(page) => sslHref(params, { page })}
        />
      ) : null}
    </div>
  )
}

const PAID_COLUMNS: Column<PaidLine>[] = [
  {
    key: 'name',
    header: 'Certificate for',
    cell: (line) => <span className="break-all">{line.name}</span>,
  },
  {
    key: 'order',
    header: 'Order',
    cell: (line) => (
      <Link href={adminHref.order(line.orderId)} className={LINK}>
        {line.orderNumber ?? 'Open the order'}
      </Link>
    ),
  },
  { key: 'product', header: 'Product code', cell: (line) => line.productCode ?? '—' },
  { key: 'paid', header: 'Paid', cell: (line) => <When at={line.paidAt} /> },
]

/** Paid certificate lines with no certificate: the queue's "Paid, no job" sends them here. */
export function PaidWithoutCertificate({ lines }: { lines: PaidLine[] | null }) {
  return (
    <Panel labelledBy="ssl-paid-heading" className="space-y-4">
      <h2 id="ssl-paid-heading" className={PANEL_HEADING}>
        {PAID_HEADING}
      </h2>
      <p className="max-w-3xl text-sm/6 text-muted-foreground">{PAID_NOTE}</p>
      {lines === null ? (
        <ErrorState title={PAID_ERROR} />
      ) : (
        <DataTable
          caption="Paid certificate lines with no certificate, oldest payment first"
          rows={lines}
          columns={PAID_COLUMNS}
          rowKey={(line) => line.id}
          empty={<p className="text-sm text-foreground">{PAID_NONE}</p>}
        />
      )}
    </Panel>
  )
}

/** `/admin/ssl` (B10): the figures, the filters, the list, then paid lines with no certificate. */
export async function SslListView({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const params = parseSslListParams(await searchParams)
  const now = new Date()
  const searchable = params.search.kind === 'none' || params.search.kind === 'name'
  const [list, stats, paid] = await Promise.all([
    searchable
      ? listCertificates(admin, side, params).catch(() => null)
      : Promise.resolve<CertificateList | null>(null),
    getSslStats(side).catch((): SslStats | null => null),
    listPaidWithoutCertificate(admin, side, now).catch((): PaidLine[] | null => null),
  ])

  return (
    <PanelPage>
      <PanelHeader
        crumbs={[{ label: 'Admin', href: '/admin' }, { label: 'Certificates' }]}
        title="Certificates"
        description={SSL_DESCRIPTION}
        actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
      />
      {stats ? <SslStatsPanel stats={stats} /> : <ErrorState title={STATS_ERROR} />}
      <Panel labelledBy="ssl-find-heading" className="space-y-4">
        <h2 id="ssl-find-heading" className={PANEL_HEADING}>
          Find certificates
        </h2>
        <SslSearch params={params} />
        <SslStatusChips params={params} counts={stats?.byStatus ?? null} />
        <SslFilterForm params={params} />
      </Panel>
      <section aria-labelledby="ssl-list-heading" className="space-y-3">
        <h2 id="ssl-list-heading" className="px-1 font-medium text-foreground">
          {list
            ? `${formatCount(list.total)} ${list.total === 1 ? 'certificate' : 'certificates'}`
            : 'Certificates'}
        </h2>
        <CertificateListBody side={side} params={params} list={list} now={now} />
      </section>
      <PaidWithoutCertificate lines={paid} />
    </PanelPage>
  )
}
