import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * The signed-in panel's building blocks: one card surface, one page header,
 * one page rhythm. Every panel page is made of these, so the pages never
 * drift from the dashboard or from each other.
 */

/** The card surface on the panel's pale blue canvas. */
export const PANEL =
  'rounded-3xl border border-brand-subtle-border bg-card/80 shadow-xs dark:bg-card/90'

export const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** A round icon link, top right of a card. */
export const ROUND_LINK =
  'grid size-11 shrink-0 place-items-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-brand-subtle active:scale-[0.97]'

/** A card's own heading. */
export const PANEL_HEADING = 'font-medium text-foreground'

/** The page's gutter beside the sidebar, and the gap between its cards. */
export function PanelPage({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-4 px-4 py-4 sm:px-6 sm:py-6 lg:px-0 lg:py-0', className)}>
      {children}
    </div>
  )
}

/** A card. `labelledBy` names it as a region for screen readers. */
export function Panel({
  children,
  className,
  labelledBy,
  id,
}: {
  children: React.ReactNode
  className?: string
  labelledBy?: string
  id?: string
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn(PANEL, 'p-5 sm:p-6', className)}>
      {children}
    </section>
  )
}

export type Crumb = { label: string; href?: string }

/** The first card on every page: where you are, what this is, and what you can do. */
export function PanelHeader({
  crumbs,
  title,
  titleAside,
  description,
  actions,
  children,
}: {
  crumbs: Crumb[]
  title: React.ReactNode
  /** Beside the title: a status pill, badges. */
  titleAside?: React.ReactNode
  description?: React.ReactNode
  /** Top right: round icon links. */
  actions?: React.ReactNode
  /** Below the title: notices, tabs. */
  children?: React.ReactNode
}) {
  return (
    <header className={cn(PANEL, 'relative overflow-hidden p-5 sm:p-7')}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-radial-[at_85%_20%] from-brand/10 via-transparent to-transparent"
      />
      <div className="relative flex items-center justify-between gap-4">
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {crumbs.map((crumb, index) => (
              <li key={crumb.label} className="flex min-w-0 items-center gap-2">
                {index > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground">
                    /
                  </span>
                ) : null}
                {crumb.href ? (
                  <Link
                    href={crumb.href}
                    className={cn(
                      'rounded text-foreground underline-offset-4 hover:underline',
                      FOCUS,
                    )}
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="truncate text-muted-foreground">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      <div className="relative mt-6 flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 text-3xl font-normal tracking-tight break-words text-foreground sm:text-4xl">
          {title}
        </h1>
        {titleAside}
      </div>
      {description ? (
        <p className="relative mt-2 max-w-2xl text-pretty text-sm/6 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children ? <div className="relative mt-6">{children}</div> : null}
    </header>
  )
}

/** A page's loading state: the header card and one content card, pulsing. */
export function PanelPageSkeleton({ height = 'h-96' }: { height?: string }) {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className={cn(PANEL, 'h-44 animate-pulse')} />
      <div className={cn(PANEL, height, 'animate-pulse')} />
    </div>
  )
}

/** One card's loading state, for content streaming under a header already shown. */
export function PanelSkeleton({ height = 'h-64' }: { height?: string }) {
  return <div aria-hidden="true" className={cn(PANEL, height, 'animate-pulse')} />
}
