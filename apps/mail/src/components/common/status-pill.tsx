import { cn } from '@/lib/utils'

/**
 * A status as a pill: the tone's tint behind its own ink, and always the
 * status's name in words — colour is never the only signal (S8). Mail's
 * emails, domains and accounts all use it; the mapping from a status to a
 * tone lives with each feature.
 */

export const TONES = ['success', 'warning', 'danger', 'info', 'neutral'] as const
export type Tone = (typeof TONES)[number]

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-tone-success text-tone-success-foreground',
  warning: 'bg-tone-warning text-tone-warning-foreground',
  danger: 'bg-tone-danger text-tone-danger-foreground',
  info: 'bg-tone-info text-tone-info-foreground',
  neutral: 'bg-tone-neutral text-tone-neutral-foreground',
}

export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: Tone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}
