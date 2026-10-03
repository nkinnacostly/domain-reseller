import { Search } from 'lucide-react'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * A list's search box: a GET form, so the URL holds what was asked. Never
 * for personal data — an email in a URL ends up in history and logs; customer
 * search is a POST on the Customers page (ADMIN-SPEC §5.2).
 */
export function TableToolbar({
  action,
  label,
  placeholder,
  defaultValue,
  keep = {},
  children,
}: {
  action: string
  label: string
  placeholder: string
  defaultValue?: string
  /** Filters to keep when searching (the current status, dates…). */
  keep?: Record<string, string | undefined>
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <search className="w-full lg:max-w-sm">
        <form action={action} method="get">
          {Object.entries(keep).map(([name, value]) =>
            value ? <input key={name} type="hidden" name={name} value={value} /> : null,
          )}
          <label className="flex h-11 items-center gap-2.5 rounded-full border border-input bg-background px-4 text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">{label}</span>
            <input
              name="q"
              type="search"
              maxLength={120}
              defaultValue={defaultValue}
              placeholder={placeholder}
              // N13: the browser refuses an email here, so it never reaches the URL.
              pattern="[^@]*"
              title="Search by reference, not an email address."
              autoComplete="off"
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            />
          </label>
          <button type="submit" className={cn('sr-only', FOCUS)}>
            Search
          </button>
        </form>
      </search>
      {children ? <div className="min-w-0">{children}</div> : null}
    </div>
  )
}
