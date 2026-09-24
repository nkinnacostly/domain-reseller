import { cn } from '@/lib/utils'
import type { DomainLabel, LabelColor } from '../lib/labels'

/**
 * FR-P3 — a label as it shows everywhere: its name on a tint of its colour.
 * The name is always there, so the colour is never the only signal (S8);
 * each tint and ink is a token pair with a dark counterpart (S2, S3).
 * Written out in full so Tailwind finds every class.
 */
export const LABEL_TONE: Record<LabelColor, string> = {
  blue: 'bg-label-blue text-label-blue-foreground',
  green: 'bg-label-green text-label-green-foreground',
  amber: 'bg-label-amber text-label-amber-foreground',
  red: 'bg-label-red text-label-red-foreground',
  purple: 'bg-label-purple text-label-purple-foreground',
  slate: 'bg-label-slate text-label-slate-foreground',
}

/** The solid swatch for a colour picker: the label's ink colour. */
export const LABEL_SWATCH: Record<LabelColor, string> = {
  blue: 'bg-label-blue-foreground',
  green: 'bg-label-green-foreground',
  amber: 'bg-label-amber-foreground',
  red: 'bg-label-red-foreground',
  purple: 'bg-label-purple-foreground',
  slate: 'bg-label-slate-foreground',
}

export function LabelChip({
  label,
  className,
}: {
  label: Pick<DomainLabel, 'name' | 'color'>
  className?: string
}) {
  return (
    <span
      data-label={label.name}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-current/20 px-2 py-0.5 text-xs font-medium',
        LABEL_TONE[label.color],
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  )
}

/** A domain's labels in a row; nothing at all when it has none. */
export function LabelChips({
  labels,
  className,
}: {
  labels: readonly DomainLabel[]
  className?: string
}) {
  if (labels.length === 0) return null
  return (
    <span className={cn('flex flex-wrap gap-1.5', className)}>
      <span className="sr-only">Labels: </span>
      {labels.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
    </span>
  )
}
