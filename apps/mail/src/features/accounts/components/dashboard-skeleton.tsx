import { Skeleton } from '@/components/ui/skeleton'

/** The shell while the person's accounts load (S11: a skeleton, not a spinner). */
export function DashboardSkeleton() {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <div className="hidden border-r border-border bg-card lg:block lg:w-76 lg:shrink-0 lg:space-y-4 lg:px-4 lg:py-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-12 w-full rounded-xl" />
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders with no identity
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
      <div className="h-16 border-b border-border lg:hidden" />
      <main id="main" className="min-w-0 flex-1 px-5 py-8 sm:px-8 lg:px-10">
        <p className="sr-only" role="status">
          Loading your dashboard
        </p>
        <PageSkeleton />
      </main>
    </div>
  )
}

/** A page's body while it loads. */
export function PageSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6">
      <Skeleton className="h-9 w-56" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-36 rounded-3xl" />
        <Skeleton className="h-36 rounded-3xl" />
      </div>
      <Skeleton className="h-48 rounded-3xl" />
    </div>
  )
}
