import { formatNaira } from '@dr/shared'
import { ArrowDown, ArrowUp, Check } from 'lucide-react'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { FOCUS } from '@/components/layout/panel'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { type Column, DataTable } from '@/features/admin/components/table/data-table'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { Pager } from '@/features/admin/components/table/pager'
import {
  LIST_COUNTS,
  LIST_ERROR,
  NO_CUSTOMERS,
  NO_CUSTOMERS_BODY,
  NO_MATCH,
  sideWord,
} from '@/features/admin/lib/customers-copy'
import type { CustomerRow } from '@/features/admin/lib/customers-data'
import {
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPES,
  CUSTOMER_SORT_LABEL,
  CUSTOMER_SORTS,
  type CustomerListParams,
  type CustomerSort,
  customersHref,
  HOLDER_FILTERS,
  HOLDER_LABEL,
  isFiltered,
  TWO_FACTOR_FILTERS,
  TWO_FACTOR_LABEL,
} from '@/features/admin/lib/customers-params'
import { labelFor } from '@/features/admin/lib/labels'
import { nextSort, pageCount } from '@/features/admin/lib/list-params'
import type { AdminSide } from '@/features/admin/lib/side'
import type { CustomerList } from '@/features/admin/queries/customers'
import { cn } from '@/lib/utils'
import { AccountLink, AdminBadge, Day, MaskedEmail, TwoFactorPill } from './parts'

/**
 * The customers list (§5.2 B8): `admin_customers`, paged and sorted in SQL,
 * every email masked. Filters and sorts are links, so the URL holds the
 * list — and never a person (N13).
 */

export const CUSTOMER_COLUMNS: Column<CustomerRow, CustomerSort>[] = [
  {
    key: 'customer',
    header: 'Customer',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <span className="inline-flex flex-col items-start gap-1">
        <AccountLink userId={row.userId} />
        <span className="inline-flex flex-wrap items-center gap-2 text-xs font-normal text-muted-foreground">
          {labelFor(ACCOUNT_TYPE_LABEL, row.accountType)}
          {row.isAdmin ? <AdminBadge /> : null}
        </span>
      </span>
    ),
  },
  {
    key: 'email',
    header: 'Email (masked)',
    className: 'whitespace-nowrap',
    cell: (row) => (
      <span className="inline-flex flex-col">
        <MaskedEmail value={row.maskedEmail} />
        {row.emailConfirmed ? null : (
          <span className="text-xs text-muted-foreground">Not confirmed</span>
        )}
      </span>
    ),
  },
  { key: 'joined', header: 'Joined', sort: 'joined', cell: (row) => <Day at={row.joinedAt} /> },
  {
    key: 'domains',
    header: 'Domains held',
    sort: 'domains',
    numeric: true,
    cell: (row) => row.domainsHeld.toLocaleString('en-GB'),
  },
  {
    key: 'orders',
    header: 'Orders paid',
    sort: 'orders',
    numeric: true,
    cell: (row) => row.ordersPaid.toLocaleString('en-GB'),
  },
  {
    key: 'paid',
    header: 'Total paid',
    sort: 'paid',
    numeric: true,
    className: 'whitespace-nowrap',
    cell: (row) => formatNaira(row.totalPaidKobo),
  },
  { key: '2fa', header: '2FA', cell: (row) => <TwoFactorPill on={row.hasTotp} /> },
  {
    key: 'signin',
    header: 'Last sign-in',
    sort: 'last_sign_in',
    cell: (row) => <Day at={row.lastSignInAt} never="Never" />,
  },
]

/** One filter: a row of chips, one value at a time; the chosen one clears itself. */
function OneOf<T extends string>({
  label,
  values,
  labels,
  current,
  href,
}: {
  label: string
  values: readonly T[]
  labels: Record<string, string>
  current: T | null
  href: (value: T | null) => string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* The nav's own name says the same to a screen reader. */}
      <span aria-hidden="true" className="shrink-0 text-sm text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <FilterChips
          label={label}
          chips={values.map((value) => ({ value, label: labels[value] ?? value }))}
          selected={current ? [current] : []}
          href={(value) => href(value === current ? null : (value as T))}
          allHref={href(null)}
        />
      </div>
    </div>
  )
}

export function CustomerFilters({ params }: { params: CustomerListParams }) {
  return (
    <div className="flex flex-col gap-1 lg:flex-row lg:flex-wrap lg:gap-x-6">
      <OneOf
        label="Domains"
        values={HOLDER_FILTERS}
        labels={HOLDER_LABEL}
        current={params.holders}
        href={(holders) => customersHref(params, { holders })}
      />
      <OneOf
        label="Two-factor"
        values={TWO_FACTOR_FILTERS}
        labels={TWO_FACTOR_LABEL}
        current={params.twofa}
        href={(twofa) => customersHref(params, { twofa })}
      />
      <OneOf
        label="Account type"
        values={ACCOUNT_TYPES}
        labels={ACCOUNT_TYPE_LABEL}
        current={params.type}
        href={(type) => customersHref(params, { type })}
      />
    </div>
  )
}

/**
 * Sorting below `xl`, where the list is cards with no column headers. The
 * current sort says so in words and with a tick (S8, S13).
 */
export function CustomerSortLinks({ params }: { params: CustomerListParams }) {
  return (
    <nav aria-label="Sort customers" className="relative -mx-1 overflow-x-auto px-1 py-1 xl:hidden">
      <ul className="flex min-w-max items-center gap-2">
        <li className="text-sm text-muted-foreground">Sort by</li>
        {CUSTOMER_SORTS.map((sort) => {
          const current = params.sort === sort
          const Arrow = params.dir === 'asc' ? ArrowUp : ArrowDown
          return (
            <li key={sort}>
              <Link
                href={customersHref(params, nextSort(params, sort))}
                aria-current={current ? 'true' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground',
                  FOCUS,
                )}
              >
                {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {CUSTOMER_SORT_LABEL[sort]}
                {current ? <Arrow className="size-3.5" aria-hidden="true" /> : null}{' '}
                <span className="sr-only">
                  {current
                    ? `(sorted ${params.dir === 'asc' ? 'ascending' : 'descending'}; select to reverse)`
                    : '(select to sort)'}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** The list and its four states (S11). */
export function CustomersList({
  side,
  testOnly,
  params,
  list,
}: {
  side: AdminSide
  testOnly: boolean
  params: CustomerListParams
  list: CustomerList | null
}) {
  if (!list) return <ErrorState title={LIST_ERROR} />

  if (list.rows.length === 0) {
    if (params.page > 1) {
      return (
        <EmptyState
          title={`Nothing on page ${params.page}.`}
          body="The list is shorter than that now."
          action={
            <Link href={customersHref(params, { page: 1 })} className={QUIET_BUTTON}>
              Go to the first page
            </Link>
          }
        />
      )
    }
    return isFiltered(params) ? (
      <EmptyState
        title={NO_MATCH}
        body="Change or clear the filters to see more."
        action={
          <Link href="/admin/customers" className={QUIET_BUTTON}>
            Clear all filters
          </Link>
        }
      />
    ) : (
      <EmptyState title={NO_CUSTOMERS(testOnly)} body={NO_CUSTOMERS_BODY(testOnly)} />
    )
  }

  const pages = pageCount(list.total, params.per)
  return (
    <div className="space-y-3">
      <p className="px-1 text-sm text-muted-foreground">{LIST_COUNTS(side)}</p>
      <CustomerSortLinks params={params} />
      <DataTable<CustomerRow, CustomerSort>
        caption={`Customers, ${sideWord(side)} side counts, page ${params.page} of ${pages}`}
        rows={list.rows}
        columns={CUSTOMER_COLUMNS}
        rowKey={(row) => row.userId}
        sorting={{
          sort: params.sort,
          dir: params.dir,
          href: (sort) => customersHref(params, nextSort(params, sort)),
        }}
        empty={null}
      />
      <Pager
        page={params.page}
        pageCount={pages}
        total={list.total}
        href={(page) => customersHref(params, { page })}
      />
    </div>
  )
}
