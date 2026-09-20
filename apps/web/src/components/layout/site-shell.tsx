import { cn } from '@/lib/utils'

/**
 * The floating card the whole site sits inside.
 *
 * It tracks the viewport rather than sitting at a fixed width — on a wide
 * display a 1200px card looks marooned. The cap only engages on ultra-wide
 * monitors, where an unbounded card would stretch past any comfortable
 * reading width. Individual sections constrain their own content.
 */
export function SiteShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="min-h-dvh bg-canvas px-3 py-3 sm:px-6 sm:py-6 lg:px-8 lg:py-8 2xl:px-12 2xl:py-12">
      <div
        className={cn(
          'mx-auto w-full max-w-[1800px] overflow-hidden rounded-2xl bg-background shadow-2xl sm:rounded-3xl',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Horizontal rhythm for everything inside the shell. One component so the
 * gutter and max width can never drift between sections.
 */
export function Container({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mx-auto w-full max-w-[1320px] px-5 sm:px-8 lg:px-12', className)}>
      {children}
    </div>
  )
}
