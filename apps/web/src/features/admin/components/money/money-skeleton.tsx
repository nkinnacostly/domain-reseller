import { PANEL, PanelPage } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * The Money page's loading states (S11): the shapes of what is coming,
 * pulsing — never a spinner. Each section streams in on its own.
 */

export function RevenueSkeleton() {
  return (
    <div aria-hidden="true" className={cn(PANEL, 'space-y-6 p-5 sm:p-6')}>
      <div className="h-5 w-48 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-1 gap-3 min-[26rem]:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <div key={index} className="h-24 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-muted" />
    </div>
  )
}

export function MarginSkeleton() {
  return (
    <div aria-hidden="true" className={cn(PANEL, 'space-y-4 p-5 sm:p-6')}>
      <div className="h-5 w-32 animate-pulse rounded bg-muted" />
      <div className="h-10 w-full animate-pulse rounded bg-muted" />
      {Array.from({ length: 4 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={index} className="h-11 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  )
}

/** The whole page, before the admin is known: the header, then both sections. */
export function MoneySkeleton() {
  return (
    <PanelPage>
      <div aria-hidden="true" className={cn(PANEL, 'h-56 animate-pulse')} />
      <RevenueSkeleton />
      <MarginSkeleton />
    </PanelPage>
  )
}
