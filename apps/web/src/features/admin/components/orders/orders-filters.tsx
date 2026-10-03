import { ArrowDown, ArrowUp, Check, Search } from 'lucide-react'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { ORDER_STATUS_LABEL } from '@/features/admin/lib/labels'
import { nextSort } from '@/features/admin/lib/list-params'
import { SEARCH_HINT, SEARCH_NOT_EMAIL, STUCK_HINT } from '@/features/admin/lib/orders-copy'
import {
  ORDER_KIND_LABEL,
  ORDER_KINDS,
  ORDER_SEARCH_MAX,
  ORDER_SORT_LABEL,
  ORDER_SORTS,
  ORDER_STATUSES,
  type OrderListParams,
  ordersHref,
  toggleStatus,
} from '@/features/admin/lib/orders-params'
import { cn } from '@/lib/utils'

/**
 * How the orders list is narrowed (docs/ADMIN-SPEC.md §5.2, B2). Every
 * control is a link or a GET form, so the URL holds the list — and none of
 * it ever holds an email: the search box refuses one before it is sent
 * (`pattern`), and the page refuses one that arrives anyway (N13).
 */

/** Hidden inputs that keep the rest of the list when one form is sent. */
function Keep({ values }: { values: Record<string, string | null | undefined> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
    </>
  )
}

function kept(params: OrderListParams) {
  return {
    status: params.status.join(',') || null,
    sort: params.sort === 'placed' ? null : params.sort,
    dir: params.dir === 'desc' ? null : params.dir,
    per: params.per === 25 ? null : String(params.per),
  }
}

export function OrdersSearch({ params }: { params: OrderListParams }) {
  return (
    <search className="w-full lg:max-w-md">
      <form action="/admin/orders" method="get" aria-label="Search orders">
        <Keep
          values={{
            ...kept(params),
            kind: params.kind,
            from: params.from,
            to: params.to,
            stuck: params.stuck ? '1' : null,
          }}
        />
        <label
          htmlFor="orders-q"
          className="flex h-11 items-center gap-2.5 rounded-full border border-input bg-background px-4 text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Search orders</span>
          <input
            id="orders-q"
            name="q"
            type="search"
            maxLength={ORDER_SEARCH_MAX}
            defaultValue={params.q}
            placeholder="ND-001035, MDH-…, INV-… or a domain"
            // N13: the browser refuses an email here, so it never reaches the URL.
            pattern="[^@]*"
            title={SEARCH_NOT_EMAIL}
            aria-describedby="orders-q-hint"
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
        </label>
        <p id="orders-q-hint" className="mt-1.5 px-1 text-xs text-muted-foreground">
          {SEARCH_HINT}
        </p>
        <button type="submit" className={cn('sr-only', FOCUS)}>
          Search
        </button>
      </form>
    </search>
  )
}

export function OrderStatusChips({ params }: { params: OrderListParams }) {
  return (
    <FilterChips
      label="Order status"
      chips={ORDER_STATUSES.map((status) => ({
        value: status,
        label: ORDER_STATUS_LABEL[status] ?? status,
      }))}
      selected={params.status}
      href={(value) =>
        ordersHref(params, {
          status: toggleStatus(params, value as (typeof ORDER_STATUSES)[number]),
        })
      }
      allHref={ordersHref(params, { status: [] })}
    />
  )
}

export function OrdersFilterForm({ params }: { params: OrderListParams }) {
  return (
    <form
      action="/admin/orders"
      method="get"
      aria-label="Filter orders"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end"
    >
      <Keep values={{ ...kept(params), q: params.q || null }} />
      <div>
        <label htmlFor="orders-kind" className="text-sm font-medium text-foreground">
          Kind
        </label>
        <select
          id="orders-kind"
          name="kind"
          defaultValue={params.kind ?? ''}
          className={cn(inputClass, 'mt-1.5')}
        >
          <option value="">Any kind</option>
          {ORDER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {ORDER_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="orders-from" className="text-sm font-medium text-foreground">
          Placed from
        </label>
        <input
          id="orders-from"
          name="from"
          type="date"
          defaultValue={params.from ?? ''}
          className={cn(inputClass, 'mt-1.5')}
        />
      </div>
      <div>
        <label htmlFor="orders-to" className="text-sm font-medium text-foreground">
          Placed to
        </label>
        <input
          id="orders-to"
          name="to"
          type="date"
          defaultValue={params.to ?? ''}
          className={cn(inputClass, 'mt-1.5')}
        />
      </div>
      <div className="min-w-0 sm:col-span-2 lg:col-span-1">
        {/* The whole row is the target (S7): the box alone is 20px. */}
        <label
          htmlFor="orders-stuck"
          className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-foreground"
        >
          <input
            id="orders-stuck"
            name="stuck"
            type="checkbox"
            value="1"
            defaultChecked={params.stuck}
            aria-describedby="orders-stuck-hint"
            className="size-5 shrink-0 accent-brand"
          />
          Stuck only
        </label>
        <p id="orders-stuck-hint" className="text-xs text-muted-foreground">
          {STUCK_HINT}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
        <button
          type="submit"
          className={cn(
            'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
            FOCUS,
          )}
        >
          Apply filters
        </button>
        <Link href="/admin/orders" className={QUIET_BUTTON}>
          Clear all
        </Link>
      </div>
    </form>
  )
}

/**
 * Sorting below `xl`, where the list is cards and has no column headers to
 * sort by. The current sort says so in words and with a tick (S8, S13).
 */
export function OrderSortLinks({ params }: { params: OrderListParams }) {
  return (
    <nav aria-label="Sort orders" className="relative -mx-1 overflow-x-auto px-1 py-1 xl:hidden">
      <ul className="flex min-w-max items-center gap-2">
        <li className="text-sm text-muted-foreground">Sort by</li>
        {ORDER_SORTS.map((sort) => {
          const current = params.sort === sort
          const Arrow = params.dir === 'asc' ? ArrowUp : ArrowDown
          return (
            <li key={sort}>
              <Link
                href={ordersHref(params, nextSort(params, sort))}
                aria-current={current ? 'true' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground',
                  FOCUS,
                )}
              >
                {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {ORDER_SORT_LABEL[sort]}
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
