import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { latinLookalike, toUnicodeLabel } from '../lib/idn'

/**
 * The ASCII form beside an international name (FR-S8): `xn--caf-dma.com` is
 * what the registry records and what the cart and checkout carry. Renders
 * nothing for an ordinary name, whose two forms are the same.
 */
export function AsciiForm({
  domain,
  display,
  className,
}: {
  domain: string
  display: string
  className?: string
}) {
  if (domain === display) return null
  return (
    <span className={cn('font-mono text-xs break-all text-muted-foreground', className)}>
      <span className="sr-only">Also written as </span>
      {domain}
    </span>
  )
}

/**
 * FR-S8 — a name written entirely in Cyrillic or Greek letters that look like
 * Latin ones (`аррӏе`) can pass for a different, Latin name (`apple`). It is
 * not refused, since it may be a real word, but nobody should buy it without
 * knowing what it can be mistaken for.
 */
export function LookalikeWarning({
  stem,
  compact = false,
  className,
}: {
  stem: string
  /** One short line, for a row in a list. */
  compact?: boolean
  className?: string
}) {
  const readable = toUnicodeLabel(stem)
  const lookalike = readable && readable !== stem ? latinLookalike(readable) : null
  if (!lookalike) return null
  if (compact) {
    return (
      <p className={cn('flex items-start gap-1.5 text-pretty text-xs text-foreground', className)}>
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        Can pass for “{lookalike.latin}” — written in {lookalike.script} letters that look Latin
      </p>
    )
  }
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-xl bg-muted px-3.5 py-2.5 text-pretty text-sm/6 text-foreground',
        className,
      )}
    >
      <TriangleAlert className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span>
        <strong className="font-medium">Looks like “{lookalike.latin}”.</strong> {readable} is
        written in {lookalike.script} letters that look like Latin ones, so people can mistake it
        for {lookalike.latin} — or for a site that uses that name.
      </span>
    </p>
  )
}
