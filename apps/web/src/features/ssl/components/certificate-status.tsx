import { CircleAlert, CircleCheck, CircleDot, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CertificateState } from '../lib/status'

const TONE = {
  waiting: { className: 'bg-muted text-foreground', Icon: Clock },
  action: { className: 'bg-accent/10 text-foreground', Icon: CircleDot },
  good: { className: 'bg-accent/10 text-foreground', Icon: CircleCheck },
  problem: { className: 'bg-destructive/10 text-foreground', Icon: CircleAlert },
} as const

/** A certificate's state, by word and icon — never colour alone (S8). */
export function CertificateStatus({
  state,
  className,
}: {
  state: CertificateState
  className?: string
}) {
  const { className: tone, Icon } = TONE[state.tone]
  return (
    <span
      data-certificate-status={state.label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        tone,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {state.label}
    </span>
  )
}
