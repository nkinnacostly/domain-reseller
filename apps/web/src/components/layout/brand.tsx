import { cn } from '@/lib/utils'

export const BRAND_NAME = 'MyDomainsHub'

/**
 * Wordmark. The mark is a globe reduced to a meridian and an orbit dot —
 * a domain is an address on a network, and it reads at 24px.
 */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
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
      <span className="text-[0.9375rem] font-bold tracking-[0.14em] text-foreground uppercase">
        {BRAND_NAME}
      </span>
    </span>
  )
}
