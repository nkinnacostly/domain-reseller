import { ArrowDown, ArrowUp, Check, Search } from 'lucide-react'
import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { STATUS_LABEL } from '@/components/common/domain-status-pill'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import {
  DELEGATION_LABEL,
  SEARCH_HINT,
  SEARCH_NOT_EMAIL,
  SOURCE_LABEL,
} from '@/features/admin/lib/domains-copy'
import {
  DELEGATION_STATES,
  DOMAIN_SEARCH_MAX,
  DOMAIN_SORT_LABEL,
  DOMAIN_SORTS,
  DOMAIN_SOURCES,
  DOMAIN_STATUSES,
  type DomainListParams,
  domainsHref,
  EXPIRY_WINDOW_LABEL,
  EXPIRY_WINDOWS,
  toggleStatus,
} from '@/features/admin/lib/domains-params'
import { nextSort } from '@/features/admin/lib/list-params'
import { cn } from '@/lib/utils'

/**
 * How the domains list is narrowed (docs/ADMIN-SPEC.md §5.2, B9). Every
 * control is a link or a GET form, so the URL holds the list — and none of
 * it ever holds an email: the search box refuses one before it is sent
 * (`pattern`), and the page refuses one that arrives anyway (N13).
 */

const APPLY = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground transition hover:bg-brand/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
  FOCUS,
)

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

function kept(params: DomainListParams) {
  return {
    status: params.status.join(',') || null,
    sort: params.sort === 'expires' ? null : params.sort,
    dir: params.dir === 'asc' ? null : params.dir,
    per: params.per === 25 ? null : String(params.per),
  }
}

export function DomainsSearch({ params }: { params: DomainListParams }) {
  return (
    <search className="w-full lg:max-w-md">
      <form action="/admin/domains" method="get" aria-label="Search domains">
        <Keep
          values={{
            ...kept(params),
            tld: params.tld,
            expires: params.expires,
            delegation: params.delegation,
            renew: params.renew,
            source: params.source,
            from: params.from,
            to: params.to,
          }}
        />
        <label
          htmlFor="domains-q"
          className="flex h-11 items-center gap-2.5 rounded-full border border-input bg-background px-4 text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Search domains</span>
          <input
            id="domains-q"
            name="q"
            type="search"
            maxLength={DOMAIN_SEARCH_MAX}
            defaultValue={params.q}
            placeholder="getpaid.com, getpaid or .com.ng"
            // N13: the browser refuses an email here, so it never reaches the URL.
            pattern="[^@]*"
            title={SEARCH_NOT_EMAIL}
            aria-describedby="domains-q-hint"
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
        </label>
        <p id="domains-q-hint" className="mt-1.5 px-1 text-xs text-muted-foreground">
          {SEARCH_HINT}
        </p>
        <button type="submit" className={cn('sr-only', FOCUS)}>
          Search
        </button>
      </form>
    </search>
  )
}

export function DomainStatusChips({ params }: { params: DomainListParams }) {
  return (
    <FilterChips
      label="Domain status"
      chips={DOMAIN_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
      selected={params.status}
      href={(value) =>
        domainsHref(params, {
          status: toggleStatus(params, value as (typeof DOMAIN_STATUSES)[number]),
        })
      }
      allHref={domainsHref(params, { status: [] })}
    />
  )
}

function Select({
  id,
  name,
  label,
  value,
  any,
  options,
}: {
  id: string
  name: string
  label: string
  value: string | null
  any: string
  options: readonly { value: string; label: string }[]
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value ?? ''} className={cn(inputClass, 'mt-1.5')}>
        <option value="">{any}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function DomainsFilterForm({
  params,
  tlds,
}: {
  params: DomainListParams
  /** The extensions the side holds (from the figures); the URL's own is kept too. */
  tlds: readonly string[]
}) {
  const extensions = [...new Set([...tlds, ...(params.tld ? [params.tld] : [])])].sort()
  return (
    <form
      action="/admin/domains"
      method="get"
      aria-label="Filter domains"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 lg:items-end"
    >
      <Keep values={{ ...kept(params), q: params.q || null }} />
      <Select
        id="domains-tld"
        name="tld"
        label="Extension"
        value={params.tld}
        any="Any extension"
        options={extensions.map((tld) => ({ value: tld, label: `.${tld}` }))}
      />
      <Select
        id="domains-expires"
        name="expires"
        label="Expiry"
        value={params.expires}
        any="Any expiry"
        options={EXPIRY_WINDOWS.map((window) => ({
          value: window,
          label: EXPIRY_WINDOW_LABEL[window],
        }))}
      />
      <Select
        id="domains-delegation"
        name="delegation"
        label="Nameservers in DNS"
        value={params.delegation}
        any="Any"
        options={DELEGATION_STATES.map((state) => ({
          value: state,
          label: DELEGATION_LABEL[state],
        }))}
      />
      <Select
        id="domains-renew"
        name="renew"
        label="Auto-renew"
        value={params.renew}
        any="On or off"
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
      />
      <Select
        id="domains-source"
        name="source"
        label="How we got it"
        value={params.source}
        any="Registered or transferred in"
        options={DOMAIN_SOURCES.map((source) => ({ value: source, label: SOURCE_LABEL[source] }))}
      />
      <div>
        <label htmlFor="domains-from" className="text-sm font-medium text-foreground">
          Added from
        </label>
        <input
          id="domains-from"
          name="from"
          type="date"
          defaultValue={params.from ?? ''}
          className={cn(inputClass, 'mt-1.5')}
        />
      </div>
      <div>
        <label htmlFor="domains-to" className="text-sm font-medium text-foreground">
          Added to
        </label>
        <input
          id="domains-to"
          name="to"
          type="date"
          defaultValue={params.to ?? ''}
          className={cn(inputClass, 'mt-1.5')}
        />
      </div>
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3 xl:col-span-1">
        <button type="submit" className={APPLY}>
          Apply filters
        </button>
        <Link href="/admin/domains" className={QUIET_BUTTON}>
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
export function DomainSortLinks({ params }: { params: DomainListParams }) {
  return (
    <nav aria-label="Sort domains" className="relative -mx-1 overflow-x-auto px-1 py-1 xl:hidden">
      <ul className="flex min-w-max items-center gap-2">
        <li className="text-sm text-muted-foreground">Sort by</li>
        {DOMAIN_SORTS.map((sort) => {
          const current = params.sort === sort
          const Arrow = params.dir === 'asc' ? ArrowUp : ArrowDown
          return (
            <li key={sort}>
              <Link
                href={domainsHref(params, nextSort(params, sort))}
                aria-current={current ? 'true' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition-transform hover:bg-brand-subtle active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground',
                  FOCUS,
                )}
              >
                {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {DOMAIN_SORT_LABEL[sort]}
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
