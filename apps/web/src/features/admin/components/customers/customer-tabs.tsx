import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { PANEL_HEADING, Panel } from '@/components/layout/panel'
import { AdminStatusPill, TestBadge } from '@/features/admin/components/admin-status-pill'
import { CopyValue } from '@/features/admin/components/copy-value'
import { DlGrid } from '@/features/admin/components/dl-grid'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { StatTile } from '@/features/admin/components/stat-tile'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { Pager } from '@/features/admin/components/table/pager'
import { canAct } from '@/features/admin/lib/actions'
import {
  ALLOWANCE_HEADING,
  ALLOWANCE_UNREAD,
  allowanceRule,
  allowanceUsed,
  CERTIFICATES_HEADING,
  CERTIFICATES_NOTE,
  DOMAINS_HEADING,
  DOMAINS_NOTE,
  EMAILS_HEADING,
  EMAILS_UNAVAILABLE,
  EMAILS_UNAVAILABLE_BODY,
  kindsText,
  LINE_KIND_LABEL,
  LINES_CAPPED,
  NO_CERTIFICATES,
  NO_DOMAINS,
  NO_ORDERS,
  ORDERS_HEADING,
  OTHER_SIDE,
  OVERVIEW_ACCOUNT_HEADING,
  OVERVIEW_SIDE_HEADING,
  SECTION_ERROR,
  sideWord,
  tierLabel,
} from '@/features/admin/lib/customers-copy'
import {
  type CustomerDetail,
  type CustomerDomain,
  type CustomerLine,
  certificatesFromLines,
  domainsFromLines,
} from '@/features/admin/lib/customers-data'
import { ACCOUNT_TYPE_LABEL, customerTabHref } from '@/features/admin/lib/customers-params'
import { formatCount, formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { LINE_STATUS_LABEL, labelFor, ORDER_STATUS_LABEL } from '@/features/admin/lib/labels'
import { pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  type CustomerOrder,
  type CustomerOrders,
  LINE_ORDERS_CAP,
  listCustomerLines,
  listCustomerOrders,
  ORDERS_PER_PAGE,
  sslProductNames,
} from '@/features/admin/queries/customers'
import type { AdminPrincipal } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { LINK, MaskedEmail, TwoFactorPill, When } from './parts'
import { RevealContact } from './reveal-contact'

/**
 * One customer's tabs (§5.2 B8). Each is read only after `admin_customer`
 * allowed this admin the account; orders and their lines come through
 * `adminDb`, by user id, on the side shown.
 */

type TabProps = { admin: AdminPrincipal; side: AdminSide; customer: CustomerDetail }

const yesNo = (value: boolean) => (value ? 'Yes' : 'No')

// ── Overview ───────────────────────────────────────────────────────────────

export function CustomerOverview({ admin, side, customer }: TabProps) {
  const { counts, allowance } = customer
  return (
    <>
      <Panel labelledBy="customer-account-heading">
        <h2 id="customer-account-heading" className={PANEL_HEADING}>
          {OVERVIEW_ACCOUNT_HEADING}
        </h2>
        <DlGrid
          className="mt-4"
          items={[
            { label: 'Email (masked)', value: <MaskedEmail value={customer.maskedEmail} /> },
            { label: 'Account type', value: labelFor(ACCOUNT_TYPE_LABEL, customer.accountType) },
            { label: 'Joined', value: formatWat(customer.joinedAt) },
            { label: 'Email confirmed', value: yesNo(customer.emailConfirmed) },
            { label: 'Two-factor', value: <TwoFactorPill on={customer.hasTotp} /> },
            {
              label: 'Last sign-in',
              value: customer.lastSignInAt ? formatWat(customer.lastSignInAt) : 'Never',
            },
            { label: 'Administrator', value: yesNo(customer.isAdmin) },
            {
              label: 'Account id',
              value: <CopyValue value={customer.userId} label="account id" />,
              wide: true,
            },
          ]}
        />
      </Panel>

      <Panel labelledBy="customer-side-heading" className="space-y-4">
        <h2 id="customer-side-heading" className={PANEL_HEADING}>
          {OVERVIEW_SIDE_HEADING(side)}
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <li>
            <StatTile
              label="Domains, any state"
              value={formatCount(counts.domains)}
              href={customerTabHref(customer.userId, 'domains')}
            />
          </li>
          <li>
            <StatTile
              label="Orders"
              value={formatCount(counts.orders)}
              href={customerTabHref(customer.userId, 'orders')}
            />
          </li>
          <li>
            <StatTile label="Paid in total" value={formatNaira(counts.spentKobo)} />
          </li>
          <li>
            <StatTile label="Refunds" value={formatCount(counts.refunds)} />
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">{OTHER_SIDE(side)}</p>
      </Panel>

      <Panel labelledBy="customer-allowance-heading" className="space-y-2">
        <h2 id="customer-allowance-heading" className={PANEL_HEADING}>
          {ALLOWANCE_HEADING}
        </h2>
        {allowance ? (
          <>
            <p className="text-foreground">
              {allowanceUsed(allowance)} ·{' '}
              <span className="font-medium">{tierLabel(allowance.tier)}</span>
            </p>
            <p className="text-sm text-muted-foreground">{allowanceRule(allowance, side)}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{ALLOWANCE_UNREAD}</p>
        )}
      </Panel>

      <Panel>
        <RevealContact userId={customer.userId} canReveal={canAct(admin, 'customer.reveal')} />
      </Panel>
    </>
  )
}

// ── Orders ─────────────────────────────────────────────────────────────────

const ORDER_COLUMNS: Column<CustomerOrder>[] = [
  {
    key: 'order',
    header: 'Order',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Link href={adminHref.order(row.id)} className={cn(LINK, 'font-medium')}>
          {row.orderNumber}
        </Link>
        {row.testMode ? <TestBadge /> : null}
      </span>
    ),
  },
  { key: 'placed', header: 'Placed', cell: (row) => <When at={row.createdAt} /> },
  { key: 'kind', header: 'Kind', cell: (row) => kindsText(row.kinds) },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <AdminStatusPill value={row.status} labels={ORDER_STATUS_LABEL} />,
  },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    className: 'whitespace-nowrap',
    cell: (row) => formatNaira(row.totalKobo),
  },
  { key: 'paid', header: 'Paid', cell: (row) => <When at={row.paidAt} never="Not paid" /> },
  {
    key: 'invoice',
    header: 'Invoice',
    className: 'whitespace-nowrap',
    cell: (row) => row.invoiceNumber ?? '—',
  },
]

export async function CustomerOrdersTab({
  admin,
  side,
  customer,
  page,
}: TabProps & { page: number }) {
  let orders: CustomerOrders
  try {
    orders = await listCustomerOrders(admin, side, customer, page)
  } catch {
    return <ErrorState title={SECTION_ERROR} />
  }
  const base = customerTabHref(customer.userId, 'orders')
  const pages = pageCount(orders.total, ORDERS_PER_PAGE)
  let body: React.ReactNode
  if (orders.total === 0) {
    body = <EmptyState title={NO_ORDERS(side)} body={OTHER_SIDE(side)} />
  } else if (orders.rows.length === 0) {
    body = (
      <EmptyState
        title={`Nothing on page ${page}.`}
        body={`The list has ${pages} ${pages === 1 ? 'page' : 'pages'}.`}
        action={
          <Link href={base} className={QUIET_BUTTON}>
            Go to the first page
          </Link>
        }
      />
    )
  } else {
    body = (
      <DataTable<CustomerOrder>
        caption={`This customer’s orders on the ${sideWord(side)} side, page ${page} of ${pages}`}
        rows={orders.rows}
        columns={ORDER_COLUMNS}
        rowKey={(row) => row.id}
        empty={null}
      />
    )
  }
  return (
    <section aria-labelledby="customer-orders-heading" className="space-y-3">
      <h2 id="customer-orders-heading" className="px-1 font-medium text-foreground">
        {ORDERS_HEADING} · {formatCount(orders.total)}
      </h2>
      {body}
      {orders.total > 0 ? (
        <Pager
          page={page}
          pageCount={pages}
          total={orders.total}
          href={(next) => (next > 1 ? `${base}?page=${next}` : base)}
        />
      ) : null}
    </section>
  )
}

// ── Domains ────────────────────────────────────────────────────────────────

const DOMAIN_COLUMNS: Column<CustomerDomain>[] = [
  {
    key: 'domain',
    header: 'Domain',
    cell: (row) =>
      row.domainId ? (
        <Link href={adminHref.domain(row.domainId)} className={cn(LINK, 'break-all')}>
          {row.domain}
        </Link>
      ) : (
        <span className="break-all">{row.domain}</span>
      ),
  },
  {
    key: 'kind',
    header: 'Latest line',
    cell: (row) => labelFor(LINE_KIND_LABEL, row.latest.itemType),
  },
  {
    key: 'status',
    header: 'Line status',
    cell: (row) => <AdminStatusPill value={row.latest.status} labels={LINE_STATUS_LABEL} />,
  },
  { key: 'when', header: 'Ordered', cell: (row) => <When at={row.latest.createdAt} /> },
  {
    key: 'order',
    header: 'Order',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <Link href={adminHref.order(row.latest.orderId)} className={LINK}>
        {row.latest.orderNumber ?? 'Open the order'}
      </Link>
    ),
  },
  { key: 'lines', header: 'Lines', numeric: true, cell: (row) => formatCount(row.lines) },
]

export async function CustomerDomainsTab({ admin, side, customer }: TabProps) {
  let lines: { lines: CustomerLine[]; capped: boolean }
  try {
    lines = await listCustomerLines(admin, side, customer)
  } catch {
    return <ErrorState title={SECTION_ERROR} />
  }
  const domains = domainsFromLines(lines.lines)
  return (
    <section aria-labelledby="customer-domains-heading" className="space-y-3">
      <h2 id="customer-domains-heading" className="px-1 font-medium text-foreground">
        {DOMAINS_HEADING} · {formatCount(domains.length)}
      </h2>
      <p className="px-1 text-sm text-muted-foreground">{DOMAINS_NOTE(side)}</p>
      {lines.capped ? (
        <p className="px-1 text-sm text-muted-foreground">{LINES_CAPPED(LINE_ORDERS_CAP)}</p>
      ) : null}
      <DataTable<CustomerDomain>
        caption={`Domains on this customer’s orders, ${sideWord(side)} side`}
        rows={domains}
        columns={DOMAIN_COLUMNS}
        rowKey={(row) => row.domain}
        empty={<EmptyState title={NO_DOMAINS(side)} body={OTHER_SIDE(side)} />}
      />
    </section>
  )
}

// ── Certificates ───────────────────────────────────────────────────────────

type CertificateRow = CustomerLine & { product: string }

const CERTIFICATE_COLUMNS: Column<CertificateRow>[] = [
  { key: 'name', header: 'Name', cell: (row) => <span className="break-all">{row.domain}</span> },
  { key: 'product', header: 'Product', cell: (row) => row.product },
  {
    key: 'status',
    header: 'Line status',
    cell: (row) => <AdminStatusPill value={row.status} labels={LINE_STATUS_LABEL} />,
  },
  { key: 'when', header: 'Ordered', cell: (row) => <When at={row.createdAt} /> },
  {
    key: 'order',
    header: 'Order',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <Link href={adminHref.order(row.orderId)} className={LINK}>
        {row.orderNumber ?? 'Open the order'}
      </Link>
    ),
  },
]

export async function CustomerCertificatesTab({ admin, side, customer }: TabProps) {
  let rows: CertificateRow[]
  let capped: boolean
  try {
    const lines = await listCustomerLines(admin, side, customer)
    const certificates = certificatesFromLines(lines.lines)
    const names = await sslProductNames(
      admin,
      side,
      certificates.flatMap((line) => (line.sslProductCode ? [line.sslProductCode] : [])),
    )
    rows = certificates.map((line) => ({
      ...line,
      product: line.sslProductCode
        ? (names.get(line.sslProductCode) ?? `Product ${line.sslProductCode}`)
        : '—',
    }))
    capped = lines.capped
  } catch {
    return <ErrorState title={SECTION_ERROR} />
  }
  return (
    <section aria-labelledby="customer-certificates-heading" className="space-y-3">
      <h2 id="customer-certificates-heading" className="px-1 font-medium text-foreground">
        {CERTIFICATES_HEADING} · {formatCount(rows.length)}
      </h2>
      <p className="px-1 text-sm text-muted-foreground">{CERTIFICATES_NOTE(side)}</p>
      {capped ? (
        <p className="px-1 text-sm text-muted-foreground">{LINES_CAPPED(LINE_ORDERS_CAP)}</p>
      ) : null}
      <DataTable<CertificateRow>
        caption={`Certificates on this customer’s orders, ${sideWord(side)} side`}
        rows={rows}
        columns={CERTIFICATE_COLUMNS}
        rowKey={(row) => row.id}
        empty={<EmptyState title={NO_CERTIFICATES(side)} body={OTHER_SIDE(side)} />}
      />
    </section>
  )
}

// ── Emails ─────────────────────────────────────────────────────────────────

export function CustomerEmailsTab() {
  return (
    <section aria-labelledby="customer-emails-heading" className="space-y-3">
      <h2 id="customer-emails-heading" className="px-1 font-medium text-foreground">
        {EMAILS_HEADING}
      </h2>
      <EmptyState
        title={EMAILS_UNAVAILABLE}
        body={EMAILS_UNAVAILABLE_BODY}
        action={
          <Link href="/admin/emails" className={QUIET_BUTTON}>
            Go to Emails
          </Link>
        }
      />
    </section>
  )
}
