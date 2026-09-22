import type { AvailabilityStatus } from '@dr/shared'
import { Check, CircleHelp, Crown, Minus, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Icon and words for every status — never colour alone (S8). */
export const STATUS = {
  available: { label: 'Available', icon: Check, tone: 'bg-accent/10 text-accent' },
  registered: { label: 'Taken', icon: X, tone: 'bg-muted text-foreground' },
  premium: { label: 'Premium', icon: Crown, tone: 'bg-muted text-foreground' },
  restricted: { label: 'Not available', icon: Minus, tone: 'bg-muted text-foreground' },
  unknown: { label: "Couldn't check", icon: CircleHelp, tone: 'bg-muted text-foreground' },
} as const satisfies Record<AvailabilityStatus, unknown>

export function ResultStatus({
  status,
  className,
}: {
  status: AvailabilityStatus
  className?: string
}) {
  const { label, icon: Icon, tone } = STATUS[status]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
        tone,
        className,
      )}
    >
      <Icon className="size-3" strokeWidth={3} aria-hidden="true" />
      {label}
    </span>
  )
}
