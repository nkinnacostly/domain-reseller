import { cn } from '@/lib/utils'

/**
 * The page's gutter and width, for every full-width section (S4): one
 * component, so the header, the pages and the footer share one left edge.
 * The same rhythm as the shop's.
 */
export function Container({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-10', className)}>
      {children}
    </div>
  )
}
