import Link from 'next/link'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/** A quiet button, built here: constants from a client module are references on the server. */
const SHOW_BUTTON = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
  FOCUS,
)

/**
 * From and to, as a GET form: the URL holds the range, like every other
 * filter (ADMIN-SPEC §5.2). Days are Lagos days; the other filters ride along
 * as hidden fields, and a new range starts at page 1.
 */
export function DateRangeForm({
  action,
  from,
  to,
  keep,
  clearHref,
}: {
  action: string
  from: string | null
  to: string | null
  /** The list's other filters, kept when the range changes. */
  keep: Record<string, string | null>
  /** The same list without a range. */
  clearHref: string
}) {
  return (
    <form
      action={action}
      method="get"
      aria-label="Created between"
      className="flex flex-wrap items-end gap-3"
    >
      {Object.entries(keep).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      <div className="min-w-0">
        <label htmlFor="queue-from" className="block text-sm text-muted-foreground">
          Created from (WAT)
        </label>
        <input
          id="queue-from"
          name="from"
          type="date"
          defaultValue={from ?? undefined}
          className={cn(inputClass, 'mt-1 w-44')}
        />
      </div>
      <div className="min-w-0">
        <label htmlFor="queue-to" className="block text-sm text-muted-foreground">
          to
        </label>
        <input
          id="queue-to"
          name="to"
          type="date"
          defaultValue={to ?? undefined}
          className={cn(inputClass, 'mt-1 w-44')}
        />
      </div>
      <button type="submit" className={SHOW_BUTTON}>
        Show
      </button>
      {from || to ? (
        <Link
          href={clearHref}
          className={cn(
            'inline-flex h-11 items-center rounded-full px-2 text-sm text-foreground underline underline-offset-4',
            FOCUS,
          )}
        >
          Any date
        </Link>
      ) : null}
    </form>
  )
}
