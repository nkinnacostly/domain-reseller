import { formatNaira } from '@dr/shared'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { STATUS_LABEL as DOMAIN_STATUS_LABEL } from '@/components/common/domain-status-pill'
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
  ALL_EMAILS,
  ALLOWANCE_HEADING,
  ALLOWANCE_UNREAD,
  allowanceRule,
  allowanceUsed,
  CERTIFICATES_HEADING,
  CERTIFICATES_NOTE,
  DOMAINS_HEADING,
  DOMAINS_NOTE,
  EMAILS_HEADING,
  EMAILS_NOTE,
  kindsText,
  NO_CERTIFICATES,
  NO_DOMAINS,
  NO_EMAILS,
  NO_ORDERS,
  ORDERS_HEADING,
  OTHER_SIDE,
  OVERVIEW_ACCOUNT_HEADING,
  OVERVIEW_SIDE_HEADING,
  ROWS_CAPPED,
  SECTION_ERROR,
  sideWord,
  tierLabel,
} from '@/features/admin/lib/customers-copy'
import type { CustomerDetail } from '@/features/admin/lib/customers-data'
import { ACCOUNT_TYPE_LABEL, customerTabHref } from '@/features/admin/lib/customers-params'
import { kindLabel } from '@/features/admin/lib/emails-copy'
import { formatCount, formatWat } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { EMAIL_STATUS_LABEL, labelFor, ORDER_STATUS_LABEL } from '@/features/admin/lib/labels'
import { pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import { CERTIFICATE_STATUS_LABEL } from '@/features/admin/lib/ssl-copy'
import {
  type Capped,
  type CustomerCertificateRow,
  type CustomerDomainRow,
  type CustomerEmailRow,
  type CustomerOrder,
  type CustomerOrders,
  listCustomerCertificates,
  listCustomerDomains,
  listCustomerEmails,
  listCustomerOrders,
  ORDERS_PER_PAGE,
  TAB_EMAILS_SHOWN,
} from '@/features/admin/queries/customers'
import type { AdminPrincipal } from '@/features/admin/queries/session'
import { cn } from '@/lib/utils'
import { Day, LINK, MaskedEmail, TwoFactorPill, When } from './parts'
import { RevealContact } from './reveal-contact'

/**
 * One customer's tabs (§5.2 B8). Each is read only after `admin_customer`
 * allowed this admin the account; orders, domains, certificates and emails
 * come through `adminDb` — orders and the masked views — by user id, on
 * the side shown.
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

const DOMAIN_COLUMNS: Column<CustomerDomainRow>[] = [
  {
    key: 'domain',
    header: 'Domain',
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Link href={adminHref.domain(row.id)} className={cn(LINK, 'break-all')}>
          {row.domainName}
        </Link>
        {row.testMode ? <TestBadge /> : null}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <AdminStatusPill value={row.status} labels={DOMAIN_STATUS_LABEL} />,
  },
  { key: 'expires', header: 'Expires', cell: (row) => <Day at={row.expiresAt} /> },
  { key: 'renew', header: 'Auto-renew', cell: (row) => (row.autoRenew ? 'On' : 'Off') },
  { key: 'registered', header: 'Registered', cell: (row) => <When at={row.registeredAt} /> },
]

/** A tab's heading, what it lists, and — past the cap — how many there are. */
function TabSection({
  id,
  heading,
  total,
  note,
  shown,
  children,
  aside,
}: {
  id: string
  heading: string
  total: number
  note: string
  shown: number
  children: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="px-1 font-medium text-foreground">
        {heading} · {formatCount(total)}
      </h2>
      <p className="px-1 text-sm text-muted-foreground">{note}</p>
      {total > shown ? (
        <p className="px-1 text-sm text-muted-foreground">{ROWS_CAPPED(shown, total)}</p>
      ) : null}
      {children}
      {aside}
    </section>
  )
}

export async function CustomerDomainsTab({ admin, side, customer }: TabProps) {
  let domains: Capped<CustomerDomainRow>
  try {
    domains = await listCustomerDomains(admin, side, customer)
  } catch {
    return <ErrorState title={SECTION_ERROR} />
  }
  return (
    <TabSection
      id="customer-domains-heading"
      heading={DOMAINS_HEADING}
      total={domains.total}
      note={DOMAINS_NOTE(side)}
      shown={domains.rows.length}
    >
      <DataTable<CustomerDomainRow>
        caption={`This customer’s domains, ${sideWord(side)} side`}
        rows={domains.rows}
        columns={DOMAIN_COLUMNS}
        rowKey={(row) => row.id}
        empty={<EmptyState title={NO_DOMAINS(side)} body={OTHER_SIDE(side)} />}
      />
    </TabSection>
  )
}

// ── Certificates ───────────────────────────────────────────────────────────

const CERTIFICATE_COLUMNS: Column<CustomerCertificateRow>[] = [
  {
    key: 'name',
    header: 'Name',
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Link href={adminHref.certificate(row.id)} className={cn(LINK, 'break-all')}>
          {row.name}
        </Link>
        {row.testMode ? <TestBadge /> : null}
      </span>
    ),
  },
  { key: 'product', header: 'Product', cell: (row) => row.product ?? '—' },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => <AdminStatusPill value={row.status} labels={CERTIFICATE_STATUS_LABEL} />,
  },
  { key: 'issued', header: 'Issued', cell: (row) => <Day at={row.issuedAt} never="Not yet" /> },
  { key: 'expires', header: 'Expires', cell: (row) => <Day at={row.expiresAt} /> },
  { key: 'ordered', header: 'Ordered', cell: (row) => <When at={row.createdAt} /> },
]

export async function CustomerCertificatesTab({ admin, side, customer }: TabProps) {
  let certificates: Capped<CustomerCertificateRow>
  try {
    certificates = await listCustomerCertificates(admin, side, customer)
  } catch {
    return <ErrorState title={SECTION_ERROR} />
  }
  return (
    <TabSection
      id="customer-certificates-heading"
      heading={CERTIFICATES_HEADING}
      total={certificates.total}
      note={CERTIFICATES_NOTE(side)}
      shown={certificates.rows.length}
    >
      <DataTable<CustomerCertificateRow>
        caption={`This customer’s certificates, ${sideWord(side)} side`}
        rows={certificates.rows}
        columns={CERTIFICATE_COLUMNS}
        rowKey={(row) => row.id}
        empty={<EmptyState title={NO_CERTIFICATES(side)} body={OTHER_SIDE(side)} />}
      />
    </TabSection>
  )
}

// ── Emails ─────────────────────────────────────────────────────────────────

const EMAIL_COLUMNS: Column<CustomerEmailRow>[] = [
  {
    key: 'kind',
    header: 'Email',
    cell: (row) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>{kindLabel(row.kind)}</span>
        {row.testMode ? <TestBadge /> : null}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    cell: (row) => (
      <span className="inline-flex flex-wrap gap-1.5">
        <AdminStatusPill value={row.status} labels={EMAIL_STATUS_LABEL} />
        {row.deliveryStatus ? (
          <AdminStatusPill value={row.deliveryStatus} labels={EMAIL_STATUS_LABEL} />
        ) : null}
      </span>
    ),
  },
  { key: 'queued', header: 'Queued', cell: (row) => <When at={row.createdAt} /> },
  { key: 'sent', header: 'Sent', cell: (row) => <When at={row.sentAt} never="Not sent" /> },
]

/**
 * The newest emails queued for this account, and the way to all of them:
 * the Emails page narrowed to the account by its id (`?user=`), never by
 * its address (N13).
 */
export async function CustomerEmailsTab({ admin, side, customer }: TabProps) {
  let emails: Capped<CustomerEmailRow>
  try {
    emails = await listCustomerEmails(admin, side, customer)
  } catch {
    return <ErrorState title={SECTION_ERROR} />
  }
  return (
    <TabSection
      id="customer-emails-heading"
      heading={EMAILS_HEADING}
      total={emails.total}
      note={EMAILS_NOTE(side, TAB_EMAILS_SHOWN)}
      shown={emails.rows.length}
      aside={
        emails.total > 0 ? (
          <Link href={adminHref.customerEmails(customer.userId)} className={QUIET_BUTTON}>
            {ALL_EMAILS}
          </Link>
        ) : null
      }
    >
      <DataTable<CustomerEmailRow>
        caption={`This customer’s newest emails, ${sideWord(side)} side`}
        rows={emails.rows}
        columns={EMAIL_COLUMNS}
        rowKey={(row) => row.id}
        empty={<EmptyState title={NO_EMAILS(side)} body={OTHER_SIDE(side)} />}
      />
    </TabSection>
  )
}
