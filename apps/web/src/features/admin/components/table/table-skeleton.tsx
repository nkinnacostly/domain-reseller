import { PANEL } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/** A list's loading state: pulsing rows, not a spinner (S11). */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className={cn(PANEL, 'space-y-3 p-4')}>
      <div className="h-5 w-1/3 animate-pulse rounded bg-muted" />
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={index} className="h-11 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  )
}
