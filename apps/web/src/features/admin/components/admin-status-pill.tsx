import { labelFor } from '@/features/admin/lib/labels'
import { TONE_CLASS, type Tone, toneOf } from '@/features/admin/lib/tone'
import { cn } from '@/lib/utils'

/**
 * A state in words, with a tint and a dot (ADMIN-SPEC §5.3). The label is in
 * the foreground colour: the status hues colour only the dot, tint and
 * border, so colour is never the only signal (S8).
 */
export function AdminStatusPill({
  value,
  labels = {},
  tone,
  className,
}: {
  value: string | null | undefined
  /** Words for each value; an unknown value shows as itself. */
  labels?: Record<string, string>
  tone?: Tone
  className?: string
}) {
  return (
    <span
      data-tone={tone ?? toneOf(value)}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap text-foreground',
        TONE_CLASS[tone ?? toneOf(value)],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-(--dot)" />
      {labelFor(labels, value)}
    </span>
  )
}

/** "Test" beside a test-mode row, in words. */
export function TestBadge() {
  return (
    <span className="inline-flex h-5 items-center rounded-md border border-status-expiring/40 bg-status-expiring/15 px-1.5 text-[0.6875rem] font-medium text-foreground">
      Test
    </span>
  )
}
