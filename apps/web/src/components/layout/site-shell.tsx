import { cn } from '@/lib/utils'

/**
 * The floating card the whole site sits inside.
 *
 * On the canvas colour, inset with a rounded corner. The inset shrinks on small
 * screens so a phone does not lose a quarter of its width to margin.
 */
export function SiteShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className="min-h-dvh bg-canvas px-3 py-3 sm:px-6 sm:py-6 lg:px-10 lg:py-10">
      <div
        className={cn(
          'mx-auto w-full max-w-[1200px] overflow-hidden rounded-2xl bg-background shadow-2xl sm:rounded-3xl',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
