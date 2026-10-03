import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { FOCUS, PANEL } from '@/components/layout/panel'
import type { Tone } from '@/features/admin/lib/tone'
import { cn } from '@/lib/utils'

const TONE_EDGE: Record<Tone, string> = {
  ok: 'before:bg-status-active',
  warning: 'before:bg-status-expiring',
  danger: 'before:bg-status-redemption',
  info: 'before:bg-status-pending',
  neutral: 'before:bg-transparent',
}

/**
 * One figure with its label. Linked, its whole tile is the link and the
 * figure is inside the link's name ("Refunds needing a person: 3"), so a
 * screen reader hears the count with the place it leads.
 */
export function StatTile({
  label,
  value,
  hint,
  href,
  tone = 'neutral',
  className,
}: {
  label: string
  value: React.ReactNode
  /** Plain text: it also completes the link's accessible name. */
  hint?: string
  href?: string
  tone?: Tone
  className?: string
}) {
  const inner = (
    <>
      <span className="block text-sm text-muted-foreground">{label}</span>{' '}
      <span className="mt-1 block text-2xl font-light tracking-tight text-foreground tabular-nums">
        {value}
      </span>
      {hint ? ' ' : null}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </>
  )
  const base = cn(
    PANEL,
    'relative block overflow-hidden p-4 before:absolute before:inset-y-0 before:left-0 before:w-1',
    TONE_EDGE[tone],
    className,
  )
  if (!href) return <div className={base}>{inner}</div>
  return (
    <Link
      href={href}
      className={cn(
        base,
        'transition hover:border-brand hover:bg-brand-subtle active:scale-[0.99]',
        FOCUS,
      )}
    >
      {inner}
      <ArrowUpRight
        aria-hidden="true"
        className="absolute top-4 right-4 size-4 text-muted-foreground"
      />
    </Link>
  )
}
