import { EMAIL_STATUSES } from '@dr/shared/mail'
import { Search } from 'lucide-react'
import Link from 'next/link'
import { EMAIL_STATUS } from '@/components/common/email-status'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import type { LogSearch, SearchField } from '../lib/search'

/**
 * The log's search form (MAIL-SPEC §10): a plain GET form, so it works before
 * the page's script loads and the address can be shared or bookmarked. Each
 * field's problem is shown under it, by name (S8).
 */

const FIELDS: {
  field: Exclude<SearchField, 'status' | 'since' | 'until'>
  label: string
  hint: string
  type: string
}[] = [
  { field: 'to', label: 'Recipient', hint: 'The whole address, in to, cc or bcc', type: 'email' },
  { field: 'subject', label: 'Subject', hint: 'Any part of it', type: 'text' },
  { field: 'tag', label: 'Tag', hint: 'name, or name:value', type: 'text' },
  { field: 'id', label: 'Email id', hint: 'As the API answered it', type: 'text' },
]

export function EmailSearch({ search }: { search: LogSearch }) {
  const { values, errors } = search
  const control = (field: SearchField, hint?: string) => ({
    id: `search-${field}`,
    name: field,
    defaultValue: values[field],
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': describedBy(`search-${field}`, errors[field], hint),
    className: inputClass,
  })
  return (
    <search aria-label="Search the email log">
      <form
        method="get"
        action="/dashboard/emails"
        className="space-y-4 rounded-3xl border border-border bg-card p-5 sm:p-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {FIELDS.map(({ field, label, hint, type }) => (
            <Field
              key={field}
              id={`search-${field}`}
              label={label}
              hint={hint}
              error={errors[field]}
            >
              <input type={type} autoComplete="off" {...control(field, hint)} />
            </Field>
          ))}
          <Field id="search-status" label="Status" error={errors.status}>
            <select {...control('status')}>
              <option value="">Any status</option>
              {EMAIL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {EMAIL_STATUS[status].label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="search-since" label="From day" hint="Lagos time" error={errors.since}>
            <input type="date" {...control('since', 'Lagos time')} />
          </Field>
          <Field
            id="search-until"
            label="To day"
            hint="Lagos time, the whole day"
            error={errors.until}
          >
            <input type="date" {...control('until', 'Lagos time')} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            <Search className="size-4" aria-hidden="true" />
            Search
          </button>
          {search.isFiltered ? (
            <Link
              href="/dashboard/emails"
              className="inline-flex min-h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
            >
              Clear the search
            </Link>
          ) : null}
        </div>
      </form>
    </search>
  )
}
