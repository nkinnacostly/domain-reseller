import type { Icon } from '@phosphor-icons/react'
import { Container } from '@/components/layout/container'
import { cn } from '@/lib/utils'

/**
 * How far the blue panel at the top of each public page sits in from the
 * viewport edge, as offsets for an absolutely positioned layer. Shared with
 * the header's mobile menu, which drops over the panel. Always smaller than
 * Container's gutter, so content on the panel keeps clear of its edge.
 */
export const PANEL_INSET_POSITION = 'inset-x-2 sm:inset-x-4 lg:inset-x-5'
export const PANEL_INSET = 'mx-2 sm:mx-4 lg:mx-5'

/**
 * The blue rounded panel every public page opens with, as the shop's
 * (CLAUDE.md §15: the header floats over it). It is a background layer, not
 * a wrapper, so the content on it uses the same Container as every section
 * below and shares their left edge at every width (S4).
 */
export function BrandPanel({
  children,
  decoration,
  className,
}: {
  children: React.ReactNode
  /** Decorative shapes painted on the panel, behind the content. */
  decoration?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden pt-2 text-brand-foreground sm:pt-4 lg:pt-5',
        className,
      )}
    >
      <div
        aria-hidden="true"
        data-testid="hero-panel"
        className={cn(
          'absolute top-2 bottom-0 mx-auto max-w-[1800px] overflow-hidden rounded-[2rem] bg-brand sm:top-4 sm:rounded-[2.5rem] lg:top-5',
          PANEL_INSET_POSITION,
        )}
      >
        {decoration}
      </div>
      {children}
    </div>
  )
}

/**
 * A white disc with a Phosphor duotone icon in brand blue (CLAUDE.md §15:
 * illustrative icons are Phosphor duotone, white discs on the blue panel).
 * Always decorative.
 */
export function IconDisc({ icon: Icon, className }: { icon: Icon; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-brand-foreground shadow-[0_14px_30px_-12px_rgb(0_0_0/0.4)]',
        className,
      )}
    >
      <Icon weight="duotone" className="size-1/2 text-brand" />
    </span>
  )
}

/** Where a page hero's icons sit: to the right of the text, from `lg` up. */
const ICON_SLOTS = [
  'top-[26%] right-[5%] size-[4.5rem] rotate-6',
  'top-[54%] right-[19%] size-16 -rotate-6',
  'top-[70%] right-[2%] size-14 rotate-3',
] as const

/**
 * The top of every public page but the home page: the blue panel with the
 * page's heading on it, and room at the top for the floating header.
 */
export function PageHero({
  eyebrow,
  title,
  intro,
  children,
  icons = [],
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  intro?: React.ReactNode
  children?: React.ReactNode
  /** Up to three icons beside the heading on wide screens. */
  icons?: readonly Icon[]
}) {
  return (
    <BrandPanel
      // Kept clear of text: light text on the panel drops below 4.5:1 over
      // the lighter arc. Its top sits 12rem above the panel's bottom, so even
      // the shortest hero (a one-line title and intro, about 22rem) keeps it
      // below the header's links.
      decoration={
        <div className="absolute -right-40 -bottom-[22rem] hidden size-[34rem] rounded-full bg-brand-arc/45 lg:block" />
      }
    >
      <Container className="relative pt-28 pb-14 sm:pt-32 sm:pb-20 lg:pt-36">
        {icons.length > 0 ? (
          <div
            aria-hidden="true"
            className="absolute inset-x-10 inset-y-0 hidden select-none lg:block"
          >
            {icons.slice(0, ICON_SLOTS.length).map((icon, index) => (
              <IconDisc
                key={ICON_SLOTS[index]}
                icon={icon}
                className={cn('absolute', ICON_SLOTS[index])}
              />
            ))}
          </div>
        ) : null}

        <div className="relative max-w-2xl">
          {eyebrow ? (
            <div className="text-sm font-medium text-brand-muted-foreground">{eyebrow}</div>
          ) : null}
          <h1
            className={cn(
              'text-[2.25rem] leading-[1.08] font-bold tracking-[-0.02em] text-balance sm:text-5xl',
              eyebrow ? 'mt-3' : undefined,
            )}
          >
            {title}
          </h1>
          {intro ? (
            <div className="mt-5 text-pretty text-brand-muted-foreground sm:text-lg [&_a]:rounded-sm [&_a]:font-medium [&_a]:text-brand-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-brand-foreground">
              {intro}
            </div>
          ) : null}
          {children ? <div className="mt-8">{children}</div> : null}
        </div>
      </Container>
    </BrandPanel>
  )
}
