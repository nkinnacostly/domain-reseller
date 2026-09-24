import { cn } from '@/lib/utils'

export const BRAND_NAME = 'MyDomainsHub'

/**
 * The logo (brand guidelines: .claude/skills/mydomainshub-brand). The mark is
 * an M whose diagonals stop short of their vertex, and the dot takes it — the
 * dot every domain name has. One geometry at every size: it reads at 16px,
 * and the favicon, app icons and public/brand/* are drawn from the same path.
 */
const TONE = {
  default: { tile: 'fill-brand', glyph: 'text-brand-foreground', name: 'text-foreground' },
  /** On the brand-blue hero: a white tile, so the mark stays a tile. */
  onBrand: { tile: 'fill-brand-foreground', glyph: 'text-brand', name: 'text-brand-foreground' },
  /** On the dark footer. */
  onFooter: { tile: 'fill-brand', glyph: 'text-brand-foreground', name: 'text-footer-foreground' },
} as const

type Tone = keyof typeof TONE

export function BrandMark({ className, tone = 'default' }: { className?: string; tone?: Tone }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={cn('size-8 shrink-0', TONE[tone].glyph, className)}
    >
      <rect width="64" height="64" rx="14" className={TONE[tone].tile} />
      <path
        d="M15 44.5V19.5L24.92 30.82M49 44.5V19.5L39.08 30.82"
        fill="none"
        stroke="currentColor"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="38.9" r="5" fill="currentColor" />
    </svg>
  )
}

/** 18px text on phones: at 20px the header (logo, cart, menu) is 4px wider than a 320px screen. */
export function Brand({ className, tone = 'default' }: { className?: string; tone?: Tone }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <BrandMark tone={tone} />
      <span className={cn('text-lg font-semibold tracking-[-0.01em] sm:text-xl', TONE[tone].name)}>
        {BRAND_NAME}
      </span>
    </span>
  )
}
