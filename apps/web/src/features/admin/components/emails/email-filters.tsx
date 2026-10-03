import { ArrowDown, ArrowUp, Check } from 'lucide-react'
import Link from 'next/link'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import {
  CATEGORY_LABEL,
  kindLabel,
  NOTICE_STATUS_LABEL,
  NOTICE_TYPE_LABEL,
  OUTBOX_STATUS_LABEL,
  STATUS_HINT,
} from '@/features/admin/lib/emails-copy'
import {
  chosen,
  EMAIL_CATEGORIES,
  EMAILS_PATH,
  type EmailsParams,
  emailsHref,
  NOTICE_STATUSES,
  NOTICE_TYPES,
  type NoticeParams,
  OUTBOX_STATUSES,
  type OutboxParams,
} from '@/features/admin/lib/emails-params'
import { shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { nextSort } from '@/features/admin/lib/list-params'
import { cn } from '@/lib/utils'
import { LINK, Note, QUIET_LINK } from './email-parts'

/**
 * How the emails lists are narrowed (docs/ADMIN-SPEC.md §5.2, B11). Every
 * control is a link or a GET form, so the URL holds the list. One status
 * at a time: choosing the chosen chip again shows them all. Nothing here
 * searches by address — recipients are masked, and an address never goes in
 * a URL (N13).
 */

/** Hidden inputs that keep the rest of the list when the dates form is sent. */
function Keep({ values }: { values: Record<string, string | null | undefined> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
    </>
  )
}

/** What a dates form keeps: everything in the URL but the dates and the page. */
function kept(params: EmailsParams): Record<string, string | null> {
  const query = new URL(emailsHref(params, { from: null, to: null }), 'https://x.invalid')
    .searchParams
  return Object.fromEntries([...query.entries()].filter(([name]) => name !== 'page'))
}

function DatesForm({
  params,
  idPrefix,
  label,
}: {
  params: EmailsParams
  idPrefix: string
  /** "Queued", "Sent": what the dates are of. */
  label: string
}) {
  return (
    <form
      action={EMAILS_PATH}
      method="get"
      aria-label={`${label} between dates`}
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
    >
      <Keep values={kept(params)} />
      <div>
        <label htmlFor={`${idPrefix}-from`} className="text-sm font-medium text-foreground">
          {label} from
        </label>
        <input
          id={`${idPrefix}-from`}
          type="date"
          name="from"
          defaultValue={params.from ?? ''}
          className={cn(inputClass, 'mt-1.5 sm:w-44')}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-to`} className="text-sm font-medium text-foreground">
          {label} to
        </label>
        <input
          id={`${idPrefix}-to`}
          type="date"
          name="to"
          defaultValue={params.to ?? ''}
          className={cn(inputClass, 'mt-1.5 sm:w-44')}
        />
      </div>
      <button type="submit" className={QUIET_LINK}>
        Apply dates
      </button>
      {params.from || params.to ? (
        <Link href={emailsHref(params, { from: null, to: null })} className={QUIET_LINK}>
          Clear dates
        </Link>
      ) : null}
    </form>
  )
}

export function OutboxFilters({ params }: { params: OutboxParams }) {
  const hint = params.status ? STATUS_HINT[params.status] : undefined
  return (
    <div className="space-y-4">
      <FilterChips
        label="Status"
        chips={OUTBOX_STATUSES.map((status) => ({
          value: status,
          label: OUTBOX_STATUS_LABEL[status],
        }))}
        selected={params.status ? [params.status] : []}
        href={(value) =>
          emailsHref(params, {
            status: chosen(params.status, value as OutboxParams['status'] & string),
          })
        }
        allHref={emailsHref(params, { status: null })}
      />
      {hint ? <Note testId="emails-status-hint">{hint}</Note> : null}
      <FilterChips
        label="Category"
        chips={EMAIL_CATEGORIES.map((category) => ({
          value: category,
          label: CATEGORY_LABEL[category],
        }))}
        selected={params.category ? [params.category] : []}
        href={(value) =>
          emailsHref(params, {
            category: chosen(params.category, value as OutboxParams['category'] & string),
          })
        }
        allHref={emailsHref(params, { category: null })}
      />
      {params.kind ? (
        <p className="flex flex-wrap items-center gap-x-3 px-1 text-sm text-foreground">
          <span>
            Only <strong className="font-medium">{kindLabel(params.kind)}</strong> emails
          </span>
          <Link href={emailsHref(params, { kind: null })} className={LINK}>
            Show every kind
          </Link>
        </p>
      ) : null}
      {params.user ? (
        <p
          data-testid="emails-user-filter"
          className="flex flex-wrap items-center gap-x-3 px-1 text-sm text-foreground"
        >
          <span>
            Only{' '}
            <Link href={adminHref.customer(params.user)} className={LINK}>
              account {shortId(params.user)}
            </Link>
            ’s emails
          </span>
          <Link href={emailsHref(params, { user: null })} className={LINK}>
            Show every account
          </Link>
        </p>
      ) : null}
      <DatesForm params={params} idPrefix="outbox" label="Queued" />
    </div>
  )
}

export function NoticeFilters({ params }: { params: NoticeParams }) {
  return (
    <div className="space-y-4">
      <FilterChips
        label="Delivery"
        chips={NOTICE_STATUSES.map((status) => ({
          value: status,
          label: NOTICE_STATUS_LABEL[status],
        }))}
        selected={params.status ? [params.status] : []}
        href={(value) =>
          emailsHref(params, {
            status: chosen(params.status, value as NoticeParams['status'] & string),
          })
        }
        allHref={emailsHref(params, { status: null })}
      />
      <FilterChips
        label="Notice"
        chips={NOTICE_TYPES.map((type) => ({ value: type, label: NOTICE_TYPE_LABEL[type] }))}
        selected={params.type ? [params.type] : []}
        href={(value) =>
          emailsHref(params, {
            type: chosen(params.type, value as NoticeParams['type'] & string),
          })
        }
        allHref={emailsHref(params, { type: null })}
      />
      <DatesForm params={params} idPrefix="notices" label="Sent" />
    </div>
  )
}

/**
 * Sorting below `xl`, where a list is cards and has no column headers to
 * sort by. The current sort says so in words and with a tick (S8, S13).
 */
export function SortLinks<P extends EmailsParams>({
  label,
  params,
  sorts,
}: {
  label: string
  params: P
  sorts: { value: P['sort']; label: string }[]
}) {
  return (
    <nav aria-label={label} className="relative -mx-1 overflow-x-auto px-1 py-1 xl:hidden">
      <ul className="flex min-w-max items-center gap-2">
        <li className="text-sm text-muted-foreground">Sort by</li>
        {sorts.map((sort) => {
          const current = params.sort === sort.value
          const Arrow = params.dir === 'asc' ? ArrowUp : ArrowDown
          return (
            <li key={sort.value}>
              <Link
                href={emailsHref(
                  params,
                  nextSort<P['sort']>(
                    { sort: params.sort, dir: params.dir },
                    sort.value,
                  ) as Partial<P>,
                )}
                aria-current={current ? 'true' : undefined}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-foreground transition hover:bg-brand-subtle active:scale-[0.98]',
                  'data-[current=true]:border-brand data-[current=true]:bg-brand data-[current=true]:text-brand-foreground',
                  FOCUS,
                )}
              >
                {current ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {sort.label}
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
