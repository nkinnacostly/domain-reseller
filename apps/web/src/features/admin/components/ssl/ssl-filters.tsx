import { ArrowDown, ArrowUp, Check, Search } from 'lucide-react'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { nextSort } from '@/features/admin/lib/list-params'
import {
  CERTIFICATE_STATUS_LABEL,
  SEARCH_HINT,
  SEARCH_NOT_EMAIL,
  UNRECOGNISED_FILTER,
  UNRECOGNISED_FILTER_HINT,
} from '@/features/admin/lib/ssl-copy'
import {
  SSL_SEARCH_MAX,
  SSL_SORT_LABEL,
  SSL_SORTS,
  SSL_STATUSES,
  type SslListParams,
  sslHref,
  toggleSslStatus,
} from '@/features/admin/lib/ssl-params'
import { cn } from '@/lib/utils'

/**
 * How the certificates list is narrowed (docs/ADMIN-SPEC.md §5.2, B10).
 * Every control is a link or a GET form, so the URL holds the list — and
 * none of it ever holds an email: the search box refuses one before it is
 * sent (`pattern`), and the page refuses one that arrives anyway (N13).
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

function kept(params: SslListParams) {
  return {
    status: params.status.join(',') || null,
    sort: params.sort === 'ordered' ? null : params.sort,
    dir: params.dir === 'desc' ? null : params.dir,
    per: params.per === 25 ? null : String(params.per),
    line: params.line,
  }
}

export function SslSearch({ params }: { params: SslListParams }) {
  return (
    <search className="w-full lg:max-w-md">
      <form action="/admin/ssl" method="get" aria-label="Search certificates">
        <Keep
          values={{
            ...kept(params),
            from: params.from,
            to: params.to,
            unrecognised: params.unrecognised ? '1' : null,
          }}
        />
        <label
          htmlFor="ssl-q"
          className="flex h-11 items-center gap-2.5 rounded-full border border-input bg-background px-4 text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Search certificates</span>
          <input
            id="ssl-q"
            name="q"
            type="search"
            maxLength={SSL_SEARCH_MAX}
            defaultValue={params.q}
            placeholder="example.com or *.example.com"
            // N13: the browser refuses an email here, so it never reaches the URL.
            pattern="[^@]*"
            title={SEARCH_NOT_EMAIL}
            aria-describedby="ssl-q-hint"
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
        </label>
        <p id="ssl-q-hint" className="mt-1.5 px-1 text-xs text-muted-foreground">
          {SEARCH_HINT}
        </p>
        <button type="submit" className={cn('sr-only', FOCUS)}>
          Search
        </button>
      </form>
    </search>
  )
}

export function SslStatusChips({
  params,
  counts,
}: {
  params: SslListParams
  /** Counts per status from the figures, when they could be read. */
  counts?: Record<string, number> | null
}) {
  return (
    <FilterChips
      label="Certificate status"
      chips={SSL_STATUSES.map((status) => ({
        value: status,
        label: CERTIFICATE_STATUS_LABEL[status] ?? status,
        ...(counts ? { count: counts[status] ?? 0 } : {}),
      }))}
      selected={params.status}
      href={(value) =>
        sslHref(params, {
          status: toggleSslStatus(params, value as (typeof SSL_STATUSES)[number]),
        })
      }
      allHref={sslHref(params, { status: [] })}
    />
  )
}

export function SslFilterForm({ params }: { params: SslListParams }) {
  return (
    <form
      action="/admin/ssl"
      method="get"
      aria-label="Filter certificates"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-end"
    >
      <Keep values={{ ...kept(params), q: params.q || null }} />
      <div>
        <label htmlFor="ssl-from" className="text-sm font-medium text-foreground">
          Ordered from
        </label>
        <input
          id="ssl-from"
          name="from"
          type="date"
          defaultValue={params.from ?? ''}
          className={cn(inputClass, 'mt-1.5')}
        />
      </div>
      <div>
        <label htmlFor="ssl-to" className="text-sm font-medium text-foreground">
          Ordered to
        </label>
        <input
          id="ssl-to"
          name="to"
          type="date"
          defaultValue={params.to ?? ''}
          className={cn(inputClass, 'mt-1.5')}
        />
      </div>
      <div className="min-w-0 sm:col-span-2 lg:col-span-1">
        {/* The whole row is the target (S7): the box alone is 20px. */}
        <label
          htmlFor="ssl-unrecognised"
          className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-foreground"
        >
          <input
            id="ssl-unrecognised"
            name="unrecognised"
            type="checkbox"
            value="1"
            defaultChecked={params.unrecognised}
            aria-describedby="ssl-unrecognised-hint"
            className="size-5 shrink-0 accent-brand"
          />
          {UNRECOGNISED_FILTER}
        </label>
        <p id="ssl-unrecognised-hint" className="text-xs text-muted-foreground">
          {UNRECOGNISED_FILTER_HINT}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
        <button
          type="submit"
          className={cn(
            'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
            FOCUS,
          )}
        >
          Apply filters
        </button>
        <Link href="/admin/ssl" className={QUIET_BUTTON}>
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
export function SslSortLinks({ params }: { params: SslListParams }) {
  return (
    <nav
      aria-label="Sort certificates"
      className="relative -mx-1 overflow-x-auto px-1 py-1 xl:hidden"
    >
      <ul className="flex min-w-max items-center gap-2">
        <li className="text-sm text-muted-foreground">Sort by</li>
        {SSL_SORTS.map((sort) => {
          const current = params.sort === sort
          const Arrow = params.dir === 'asc' ? ArrowUp : ArrowDown
          return (
            <li key={sort}>
              <Link
                href={sslHref(params, nextSort(params, sort))}
                aria-current={current ? 'true' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground',
                  FOCUS,
                )}
              >
                {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {SSL_SORT_LABEL[sort]}
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
