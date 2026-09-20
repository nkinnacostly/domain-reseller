import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Hero visual. The reference puts a photo here with floating image bubbles on
 * connector lines; we show the product instead — a real availability result,
 * with the renewal price sitting next to the first-year price, because that is
 * the promise the whole storefront is built on (PRD N8).
 *
 * Decorative throughout, so it is hidden from assistive tech: the same
 * information is in the page copy and the search results.
 */

type Chip = {
  tld: string
  /** Position as a percentage of the container, so it scales with the box. */
  top: string
  left: string
  size: string
  tone: string
  /**
   * Chips are hidden below `sm`. A phone is too narrow for both the card and a
   * ring of chips — they collide, and the card is the part that matters.
   */
}

const CHIPS: Chip[] = [
  // Positioned clear of the centre card and inset from every edge.
  {
    tld: '.ng',
    top: '4%',
    left: '6%',
    size: 'size-16 sm:size-[4.5rem]',
    tone: 'bg-accent text-accent-foreground',
  },
  {
    tld: '.com',
    top: '1%',
    left: '72%',
    size: 'size-14 sm:size-16',
    tone: 'bg-primary text-primary-foreground',
  },
  {
    tld: '.com.ng',
    top: '74%',
    left: '2%',
    size: 'size-[4.25rem] sm:size-[4.75rem]',
    tone: 'bg-background text-foreground ring-1 ring-border',
  },
  {
    tld: '.africa',
    top: '80%',
    left: '70%',
    size: 'size-14 sm:size-16',
    tone: 'bg-background text-foreground ring-1 ring-border',
  },
]

export type HeroVisualProps = {
  className?: string
  /**
   * The real .ng prices. The card shows an actual quote, so it must not carry
   * a hardcoded figure — it showed ₦18,500 while .ng was ₦20,900, which is a
   * wrong price in the first thing a visitor sees.
   */
  firstYear: string | null
  renewal: string | null
}

export function HeroVisual({ className, firstYear, renewal }: HeroVisualProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('relative aspect-[3/2] w-full select-none sm:aspect-[5/4]', className)}
    >
      {/* Connector lines, echoing the reference's flowing strands. */}
      <svg
        viewBox="0 0 400 320"
        fill="none"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full text-foreground/15"
      >
        <title>Decorative connecting lines</title>
        <path
          d="M-10 92 C 70 52, 150 132, 230 88 S 380 40, 420 76"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M-10 126 C 80 90, 160 168, 244 124 S 386 78, 420 112"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M-10 236 C 84 200, 156 274, 248 232 S 380 190, 420 220"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>

      {/* The result card — the product, shown rather than described. */}
      <div className="absolute top-1/2 left-1/2 w-[72%] max-w-[20rem] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-background p-4 shadow-[0_24px_60px_-22px_rgb(0_0_0/0.35)] sm:p-5">
        <div className="flex items-center gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
            <Check className="size-3" strokeWidth={3} />
          </span>
          <span className="truncate text-sm font-semibold text-foreground sm:text-base">
            getpaid.ng
          </span>
          <span className="ml-auto shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
            Available
          </span>
        </div>

        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[0.6875rem] text-muted-foreground">First year</p>
            <p className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              {firstYear ?? '—'}
            </p>
          </div>
          <div className="min-w-0 text-right">
            <p className="text-[0.6875rem] text-muted-foreground">Renews at</p>
            <p className="text-sm font-semibold text-foreground">
              {renewal ? `${renewal}/yr` : '—'}
            </p>
          </div>
        </div>

        <div className="mt-4 h-9 rounded-full bg-accent" />
      </div>

      {CHIPS.map((chip) => (
        <span
          key={chip.tld}
          style={{ top: chip.top, left: chip.left }}
          className={cn(
            'absolute hidden place-items-center rounded-full text-xs font-semibold shadow-lg sm:grid sm:text-sm',
            chip.size,
            chip.tone,
          )}
        >
          {chip.tld}
        </span>
      ))}
    </div>
  )
}
