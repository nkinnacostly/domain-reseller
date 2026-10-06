import { cn } from '@/lib/utils'

/**
 * A code block that scrolls sideways inside itself, never the page (S5). The
 * scroll box takes focus so a keyboard can scroll it and a screen reader can
 * name it (axe scrollable-region-focusable); `relative` keeps anything
 * absolutely positioned inside its clip (CLAUDE.md §15). Navy in both
 * themes, like the footer, so it reads the same on the blue panel and off it.
 */
export function CodeSample({
  label,
  title,
  code,
  className,
}: {
  /** The scroll box's accessible name. */
  label: string
  /** Shown above the code, e.g. the endpoint. */
  title?: React.ReactNode
  code: string
  className?: string
}) {
  return (
    <figure
      className={cn(
        'min-w-0 overflow-hidden rounded-3xl bg-footer text-footer-foreground shadow-[0_30px_60px_-30px_rgb(0_0_0/0.55)]',
        className,
      )}
    >
      {title ? (
        <figcaption className="border-b border-footer-border px-5 py-3 font-mono text-xs text-footer-muted-foreground">
          {title}
        </figcaption>
      ) : null}
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll box takes focus so a keyboard can scroll it (WCAG 2.1.1)
        tabIndex={0}
        aria-label={label}
        className="relative overflow-x-auto rounded-b-3xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-footer-foreground"
      >
        <pre className="w-max min-w-full px-5 py-4 font-mono text-[0.8rem]/6">
          <code>{code}</code>
        </pre>
      </section>
    </figure>
  )
}
