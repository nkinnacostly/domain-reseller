import { CircleAlert, Inbox, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { Container } from '@/components/layout/container'
import { Skeleton } from '@/components/ui/skeleton'
import { adminErrorWords } from '@/features/admin/lib/errors'
import { cn } from '@/lib/utils'

/**
 * The parts every Mail admin page is built from (MAIL-SPEC §10): a titled
 * page in the site's Container (S4), cards, tiles, lists and the four states
 * of S11 — loading (a skeleton), empty, an error with a next action, success.
 */

export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export const LINK = cn(
  'rounded-sm font-medium text-brand-ink underline-offset-4 hover:underline',
  FOCUS,
)

export function AdminPage({
  title,
  intro,
  icon: Icon,
  actions,
  children,
}: {
  title: string
  intro?: React.ReactNode
  icon?: LucideIcon
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Container className="py-6 sm:py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            {Icon ? (
              <Icon className="size-6 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : null}
            {title}
          </h1>
          {intro ? (
            <div className="mt-2 text-pretty text-sm/6 text-muted-foreground">{intro}</div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="mt-6 space-y-6">{children}</div>
    </Container>
  )
}

export function Card({
  title,
  id,
  children,
  className,
  actions,
}: {
  title?: string
  id?: string
  children: React.ReactNode
  className?: string
  actions?: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={title && id ? id : undefined}
      className={cn('min-w-0 rounded-3xl border border-border bg-card p-5 sm:p-6', className)}
    >
      {title ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id={id} className="font-semibold">
            {title}
          </h2>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** A figure with its name; `href` makes it the way to where it is worked. */
export function StatTile({
  label,
  value,
  hint,
  href,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  href?: string
}) {
  const body = (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  )
  const box = 'block min-w-0 rounded-2xl border border-border bg-card p-4'
  return href ? (
    <Link
      href={href}
      className={cn(box, 'transition-colors hover:bg-muted active:scale-[0.99]', FOCUS)}
    >
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  )
}

/** Label and value pairs, wrapping on a phone. */
export function Facts({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{row.label}</dt>
          <dd className="mt-0.5 break-words text-sm">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A table's own scroll box (S5): the page never scrolls sideways; `relative` keeps sr-only text inside. */
export function TableBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box takes focus so a keyboard can scroll it (WCAG 2.1.1)
      tabIndex={0}
      className={cn('relative overflow-x-auto rounded-2xl border border-border', FOCUS)}
    >
      {children}
    </section>
  )
}

export const TH = 'whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-muted-foreground'
export const TD = 'px-4 py-3 align-top text-sm'

export function EmptyState({ title, body }: { title: string; body?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-3xl border border-dashed border-border px-6 py-10 text-center">
      <Inbox className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">{title}</p>
      {body ? (
        <div className="max-w-md text-pretty text-sm text-muted-foreground">{body}</div>
      ) : null}
    </div>
  )
}

/** A read that failed or was refused: what happened, and what to do next (S11). */
export function ErrorState({ code, retryHref }: { code: string; retryHref: string }) {
  const refused = code === 'test_admin' || code === 'role' || code === 'needs_code'
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-3xl bg-tone-danger px-5 py-4 text-sm text-tone-danger-foreground"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-semibold">
          {refused ? 'This is not shown to you' : 'This could not be loaded'}
        </p>
        <p>{refused ? adminErrorWords(code) : 'Nothing was changed. Try again in a moment.'}</p>
        {refused ? null : (
          <Link href={retryHref} className={cn('font-medium underline underline-offset-4', FOCUS)}>
            Try again
          </Link>
        )}
      </div>
    </div>
  )
}

export function PageSkeleton() {
  return (
    <Container className="py-6 sm:py-8">
      <p className="sr-only" role="status">
        Loading
      </p>
      <div aria-hidden="true" className="space-y-6">
        <Skeleton className="h-9 w-56" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders with no identity
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-3xl" />
      </div>
    </Container>
  )
}

/** Previous and next, as links that keep the other filters. */
export function Pager({
  page,
  total,
  pageSize,
  hrefFor,
}: {
  page: number
  total: number
  pageSize: number
  hrefFor: (page: number) => string
}) {
  const last = Math.max(1, Math.ceil(total / pageSize))
  if (last <= 1) return null
  const button = cn(
    'inline-flex min-h-11 items-center rounded-full border border-border px-4 text-sm transition hover:bg-muted active:scale-[0.98]',
    FOCUS,
  )
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Page {page} of {last}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className={button}>
            Previous
          </Link>
        ) : null}
        {page < last ? (
          <Link href={hrefFor(page + 1)} className={button}>
            Next
          </Link>
        ) : null}
      </div>
    </nav>
  )
}

/** A row of links that filter a list, the current one marked (S13). */
export function FilterLinks({
  label,
  options,
}: {
  label: string
  options: { href: string; label: string; current: boolean }[]
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-2">
        {options.map((option) => (
          <li key={option.href}>
            <Link
              href={option.href}
              aria-current={option.current ? 'page' : undefined}
              data-current={option.current ? 'true' : undefined}
              className={cn(
                'inline-flex min-h-11 items-center rounded-full border border-border px-4 text-sm text-muted-foreground transition hover:bg-muted active:scale-[0.98]',
                'data-[current=true]:border-foreground data-[current=true]:font-semibold data-[current=true]:text-foreground data-[current=true]:underline data-[current=true]:underline-offset-4',
                FOCUS,
              )}
            >
              {option.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
