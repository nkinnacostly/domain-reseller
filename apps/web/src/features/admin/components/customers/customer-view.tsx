import Link from 'next/link'
import { Suspense } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { PanelHeader, PanelPage } from '@/components/layout/panel'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { TableSkeleton } from '@/features/admin/components/table/table-skeleton'
import {
  CUSTOMER_ERROR,
  CUSTOMER_NOT_FOUND,
  CUSTOMER_NOT_FOUND_BODY,
  CUSTOMER_TEST_ADMIN,
  CUSTOMER_TEST_ADMIN_BODY,
  sideWord,
} from '@/features/admin/lib/customers-copy'
import type { CustomerDetail } from '@/features/admin/lib/customers-data'
import {
  ACCOUNT_TYPE_LABEL,
  type CustomerTab,
  customerTabs,
  tabPage,
} from '@/features/admin/lib/customers-params'
import { formatWatDate, shortId } from '@/features/admin/lib/format'
import { labelFor } from '@/features/admin/lib/labels'
import type { AdminSide } from '@/features/admin/lib/side'
import { type CustomerLookup, getCustomer } from '@/features/admin/queries/customers'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import {
  CustomerCertificatesTab,
  CustomerDomainsTab,
  CustomerEmailsTab,
  CustomerOrdersTab,
  CustomerOverview,
} from './customer-tabs'
import { AdminBadge } from './parts'

type Search = Record<string, string | string[] | undefined>

const CRUMBS = [
  { label: 'Admin', href: '/admin' },
  { label: 'Customers', href: '/admin/customers' },
]

function Header({
  admin,
  side,
  customer,
}: {
  admin: AdminPrincipal
  side: AdminSide
  customer: CustomerDetail | null
}) {
  return (
    <PanelHeader
      crumbs={[...CRUMBS, { label: customer ? `Account ${shortId(customer.userId)}` : 'Customer' }]}
      title={customer ? <span className="break-all">{customer.maskedEmail}</span> : 'Customer'}
      titleAside={
        customer ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {labelFor(ACCOUNT_TYPE_LABEL, customer.accountType)}
            </span>
            {customer.isAdmin ? <AdminBadge /> : null}
          </span>
        ) : null
      }
      description={
        customer
          ? `Account ${shortId(customer.userId)}, joined ${formatWatDate(customer.joinedAt)}. Email masked; counts and records on the ${sideWord(side)} side.`
          : undefined
      }
      actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
    >
      {customer ? (
        <RouteTabs
          label="Customer"
          tabs={customerTabs(customer.userId, { orders: customer.counts.orders })}
        />
      ) : null}
    </PanelHeader>
  )
}

function Body({
  admin,
  side,
  customer,
  tab,
  page,
}: {
  admin: AdminPrincipal
  side: AdminSide
  customer: CustomerDetail
  tab: CustomerTab
  page: number
}) {
  const props = { admin, side, customer }
  switch (tab) {
    case 'overview':
      return <CustomerOverview {...props} />
    case 'orders':
      return (
        <Suspense fallback={<TableSkeleton rows={5} />}>
          <CustomerOrdersTab {...props} page={page} />
        </Suspense>
      )
    case 'domains':
      return (
        <Suspense fallback={<TableSkeleton rows={5} />}>
          <CustomerDomainsTab {...props} />
        </Suspense>
      )
    case 'certificates':
      return (
        <Suspense fallback={<TableSkeleton rows={3} />}>
          <CustomerCertificatesTab {...props} />
        </Suspense>
      )
    case 'emails':
      return (
        <Suspense fallback={<TableSkeleton rows={5} />}>
          <CustomerEmailsTab {...props} />
        </Suspense>
      )
  }
}

/**
 * `/admin/customers/[id]` and its tabs (B8): the masked account from
 * `admin_customer`, then the tab. A test admin asking for an account that is
 * not an e2e one is told it is not shown, and nothing else is read (D15).
 */
export async function CustomerView({
  params,
  tab,
  searchParams,
}: {
  params: Promise<{ id: string }>
  tab: CustomerTab
  searchParams?: Promise<Search>
}) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const { id } = await params
  const page = searchParams ? tabPage(await searchParams) : 1

  let lookup: CustomerLookup
  try {
    lookup = await getCustomer(admin, side, id)
  } catch {
    return (
      <PanelPage>
        <Header admin={admin} side={side} customer={null} />
        <ErrorState title={CUSTOMER_ERROR} />
      </PanelPage>
    )
  }

  if (lookup.kind !== 'ok') {
    const testAdmin = lookup.kind === 'test_admin'
    return (
      <PanelPage>
        <Header admin={admin} side={side} customer={null} />
        <EmptyState
          title={testAdmin ? CUSTOMER_TEST_ADMIN : CUSTOMER_NOT_FOUND}
          body={testAdmin ? CUSTOMER_TEST_ADMIN_BODY : CUSTOMER_NOT_FOUND_BODY}
          action={
            <Link href="/admin/customers" className={QUIET_BUTTON}>
              Back to customers
            </Link>
          }
        />
      </PanelPage>
    )
  }

  return (
    <PanelPage>
      <Header admin={admin} side={side} customer={lookup.customer} />
      <Body admin={admin} side={side} customer={lookup.customer} tab={tab} page={page} />
    </PanelPage>
  )
}
