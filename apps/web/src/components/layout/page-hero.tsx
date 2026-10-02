import type { Icon } from '@phosphor-icons/react'
import { Container, PAGE_INSET_POSITION } from '@/components/layout/site-shell'
import { cn } from '@/lib/utils'

/**
 * The blue rounded panel at the top of every page.
 *
 * It is a background layer rather than a wrapper, so the content on it uses
 * the same Container as every section below and shares their left edge at
 * every width (S4). The header floats over its top edge, and the panel clips
 * whatever sits inside it — a phone mockup peeking up from the bottom, say.
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
          PAGE_INSET_POSITION,
        )}
      >
        {decoration}
      </div>
      {children}
    </div>
  )
}

/**
 * A white disc with a Phosphor icon in it, duotone in brand blue, bobbing
 * gently. Always decorative. (Emoji were used before: they render
 * differently on every device and read as generic.)
 */
export function FloatingIcon({
  icon: Icon,
  className,
  delay = '0s',
}: {
  icon: Icon
  className?: string
  delay?: string
}) {
  return (
    <span
      style={{ animationDelay: delay }}
      className={cn(
        'absolute grid animate-float place-items-center rounded-full bg-brand-foreground shadow-[0_14px_30px_-12px_rgb(0_0_0/0.4)]',
        className,
      )}
    >
      <Icon weight="duotone" className="size-1/2 text-brand" />
    </span>
  )
}

/** Where a page hero's icons sit: to the right of the text, from `lg` up. */
const ICON_SLOTS = [
  { className: 'top-[26%] right-[5%] size-[4.5rem] rotate-6', delay: '0s' },
  { className: 'top-[54%] right-[19%] size-16 -rotate-6', delay: '1.4s' },
  { className: 'top-[70%] right-[2%] size-14 rotate-3', delay: '2.8s' },
] as const

/**
 * The top of every page but the home page: the blue panel with the page's
 * heading on it. Pass `title` for a plain h1, or render your own heading in
 * `children` when it depends on request data (search results do).
 */
export function PageHero({
  eyebrow,
  title,
  intro,
  children,
  icons = [],
}: {
  eyebrow?: React.ReactNode
  title?: React.ReactNode
  intro?: React.ReactNode
  children?: React.ReactNode
  /** Up to three icons floating to the right of the heading. */
  icons?: Icon[]
}) {
  return (
    <BrandPanel
      // Kept clear of the text: secondary text on the panel is 4.8:1 against
      // plain blue and would drop below 4.5:1 over the lighter arc.
      decoration={
        <div className="absolute -right-40 -bottom-72 hidden size-[38rem] rounded-full bg-brand-arc/45 lg:block" />
      }
    >
      {/* Room at the top for the header. */}
      <Container className="relative pt-28 pb-14 sm:pt-32 sm:pb-20 lg:pt-36">
        {icons.length > 0 ? (
          <div
            aria-hidden="true"
            className="absolute inset-x-10 inset-y-0 hidden select-none lg:block"
          >
            {icons.slice(0, ICON_SLOTS.length).map((icon, index) => (
              <FloatingIcon
                key={ICON_SLOTS[index]?.delay}
                icon={icon}
                className={ICON_SLOTS[index]?.className}
                delay={ICON_SLOTS[index]?.delay}
              />
            ))}
          </div>
        ) : null}

        <div className="relative max-w-2xl">
          {eyebrow ? (
            <p className="text-sm font-medium text-brand-muted-foreground">{eyebrow}</p>
          ) : null}
          {title ? (
            <h1
              className={cn(
                'text-[2.25rem] leading-[1.08] font-bold tracking-[-0.02em] text-balance sm:text-5xl',
                eyebrow ? 'mt-3' : undefined,
              )}
            >
              {title}
            </h1>
          ) : null}
          {intro ? (
            <div className="mt-5 text-pretty text-brand-muted-foreground sm:text-lg [&_a]:rounded-sm [&_a]:font-medium [&_a]:text-brand-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-brand-foreground">
              {intro}
            </div>
          ) : null}
          {children ? <div className={title || intro ? 'mt-8' : undefined}>{children}</div> : null}
        </div>
      </Container>
    </BrandPanel>
  )
}
