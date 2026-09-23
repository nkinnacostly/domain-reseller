import { cn } from '@/lib/utils'

export const BRAND_NAME = 'MyDomainsHub'

/**
 * Wordmark. The mark is a globe reduced to a meridian and an orbit dot —
 * a domain is an address on a network, and it reads at 24px.
 */
const TONE = {
  default: { mark: 'bg-primary text-primary-foreground', name: 'text-foreground' },
  /** On the brand-blue hero. */
  onBrand: { mark: 'bg-brand-foreground text-brand', name: 'text-brand-foreground' },
  /** On the dark footer. */
  onFooter: { mark: 'bg-brand text-brand-foreground', name: 'text-footer-foreground' },
} as const

export function Brand({
  className,
  tone = 'default',
}: {
  className?: string
  tone?: keyof typeof TONE
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', TONE[tone].mark)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
          <title>Globe mark</title>
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <ellipse
            cx="12"
            cy="12"
            rx="3.6"
            ry="8.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path d="M3.9 9.4h16.2M3.9 14.6h16.2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </span>
      <span
        className={cn('text-[0.9375rem] font-bold tracking-[0.14em] uppercase', TONE[tone].name)}
      >
        {BRAND_NAME}
      </span>
    </span>
  )
}
