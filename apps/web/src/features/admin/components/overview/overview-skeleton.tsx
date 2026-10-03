import { PANEL, PanelPage, PanelSkeleton } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * The overview's loading states (S11): the shapes of what is coming,
 * pulsing — never a spinner. Each section streams in on its own.
 */

/** A card of tiles: its heading, then `count` tiles. */
export function TilesSkeleton({ count, className }: { count: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn(PANEL, 'space-y-4 p-5 sm:p-6', className)}>
      <div className="h-5 w-40 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-1 gap-3 min-[26rem]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: count }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          <div key={index} className="h-24 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    </div>
  )
}

/** Sales, the float and the charts, while `admin_overview` is read. */
export function BusinessSkeleton() {
  return (
    <>
      <TilesSkeleton count={10} />
      <TilesSkeleton count={2} />
      <div aria-hidden="true" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PanelSkeleton height="h-72" />
        <PanelSkeleton height="h-72" />
        <PanelSkeleton height="h-72" />
        <PanelSkeleton height="h-72" />
      </div>
    </>
  )
}

/** The whole page, before the admin is known: header, health, tiles. */
export function OverviewSkeleton() {
  return (
    <PanelPage>
      <div aria-hidden="true" className={cn(PANEL, 'h-44 animate-pulse')} />
      <TilesSkeleton count={8} />
      <TilesSkeleton count={10} />
      <BusinessSkeleton />
    </PanelPage>
  )
}
