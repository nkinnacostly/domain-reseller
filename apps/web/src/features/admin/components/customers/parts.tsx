import Link from 'next/link'
import { FOCUS } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { formatWatDate, formatWatTime, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { cn } from '@/lib/utils'

/** Small pieces the customers pages share (docs/ADMIN-SPEC.md §5.2, B8). */

export const LINK = cn('rounded text-foreground underline-offset-4 hover:underline', FOCUS)

/**
 * A time in a cell: the day, then the time in WAT, each kept whole, so a
 * narrow column breaks between them rather than inside "3 Oct 2026".
 */
export function When({ at, never = '—' }: { at: string | null | undefined; never?: string }) {
  if (!at) return <>{never}</>
  return (
    <time dateTime={at}>
      <span className="whitespace-nowrap">{formatWatDate(at)}</span>{' '}
      <span className="whitespace-nowrap text-muted-foreground">{formatWatTime(at)}</span>
    </time>
  )
}

/** A day alone, in WAT — for a list, where the time would crowd the columns. */
export function Day({ at, never = '—' }: { at: string | null | undefined; never?: string }) {
  if (!at) return <>{never}</>
  return (
    <time dateTime={at} className="whitespace-nowrap">
      {formatWatDate(at)}
    </time>
  )
}

/** Two-factor in words, with a tint: never colour alone (S8). */
export function TwoFactorPill({ on }: { on: boolean }) {
  return <AdminStatusPill value={on ? 'On' : 'Off'} tone={on ? 'ok' : 'neutral'} />
}

/** "Admin" beside an account that is one; nothing otherwise. */
export function AdminBadge() {
  return <AdminStatusPill value="Admin" tone="info" />
}

/** The masked email, marked so a test can find every one on the page. */
export function MaskedEmail({ value }: { value: string }) {
  return (
    <span data-masked-email="" className="break-words">
      {value}
    </span>
  )
}

/** An account, by its short id — never by email (N13) — linked to its page. */
export function AccountLink({ userId, className }: { userId: string; className?: string }) {
  return (
    <Link href={adminHref.customer(userId)} className={cn(LINK, 'font-medium', className)}>
      Account {shortId(userId)}
    </Link>
  )
}
