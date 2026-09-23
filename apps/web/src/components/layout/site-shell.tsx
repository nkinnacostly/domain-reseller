import { cn } from '@/lib/utils'

/**
 * How far the blue hero panel at the top of each page sits in from the
 * viewport edge — as margins, and as offsets for an absolutely positioned
 * layer. Shared so the header's mobile menu, which drops over the panel, lines
 * up with it. Always smaller than Container's gutter, so content on the panel
 * keeps clear of its edge.
 */
export const PAGE_INSET = 'mx-2 sm:mx-4 lg:mx-5'
export const PAGE_INSET_POSITION = 'inset-x-2 sm:inset-x-4 lg:inset-x-5'

/**
 * Horizontal rhythm for every section on every page. One component so the
 * gutter and max width can never drift between sections (S4).
 *
 * The site is a plain page, not a card on a canvas, so content sits in a
 * centred column; long-form text is narrowed further by its own block
 * (`max-w-xl` on a paragraph, for instance).
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
