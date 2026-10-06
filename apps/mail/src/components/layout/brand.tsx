import { cn } from '@/lib/utils'

export const BRAND_NAME = 'MyDomainsHub'
export const PRODUCT_NAME = 'MyDomainsHub Mail'

/**
 * The logo (.claude/skills/mydomainshub-brand): the shop's mark — an M whose
 * diagonals stop short, and the dot that takes their vertex — with the
 * wordmark, then "Mail" in a lighter weight, so Mail reads as the same
 * company's product. One geometry at every size; `brand.test.tsx` holds it
 * to the shop's icon.
 */
const TONE = {
  default: { tile: 'fill-brand', glyph: 'text-brand-foreground', name: 'text-foreground' },
  /** On the brand-blue panel: a white tile, so the mark stays a tile. */
  onBrand: { tile: 'fill-brand-foreground', glyph: 'text-brand', name: 'text-brand-foreground' },
  /** On the dark footer. */
  onFooter: { tile: 'fill-brand', glyph: 'text-brand-foreground', name: 'text-footer-foreground' },
} as const

type Tone = keyof typeof TONE

export const MARK_PATH = 'M15 44.5V19.5L24.92 30.82M49 44.5V19.5L39.08 30.82'

export function BrandMark({ className, tone = 'default' }: { className?: string; tone?: Tone }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={cn('size-8 shrink-0', TONE[tone].glyph, className)}
    >
      <rect width="64" height="64" rx="14" className={TONE[tone].tile} />
      <path
        d={MARK_PATH}
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

/**
 * 18px text on phones, 20px from `sm`: the brand's 5/8 ratio. `compact`, for
 * the header, shows the mark and "Mail" alone below `sm`: "MyDomainsHub Mail"
 * beside the navigation is 61px wider than a 320px screen (e2e, 6 Oct 2026).
 * The link around it carries the full name for screen readers.
 */
export function Brand({
  className,
  tone = 'default',
  compact = false,
}: {
  className?: string
  tone?: Tone
  compact?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <BrandMark tone={tone} />
      <span className={cn('text-lg tracking-[-0.01em] sm:text-xl', TONE[tone].name)}>
        <span className={cn('font-semibold', compact && 'hidden sm:inline')}>{BRAND_NAME} </span>
        <span className={compact ? 'font-semibold sm:font-normal' : 'font-normal'}>Mail</span>
      </span>
    </span>
  )
}
