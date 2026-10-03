import { Info } from 'lucide-react'
import Link from 'next/link'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { formatWatDate, formatWatTime, shortId } from '@/features/admin/lib/format'
import { adminHref } from '@/features/admin/lib/href'
import { certificateState } from '@/features/admin/lib/ssl-copy'
import { cn } from '@/lib/utils'

/** Small pieces both certificate pages use. */

export const LINK =
  'rounded text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * A time in a table cell: the day, then the time in WAT, each kept whole, so
 * a narrow column breaks between them rather than inside "3 Oct 2026".
 */
export function When({ at, none = '—' }: { at: string | null | undefined; none?: string }) {
  if (!at) return <>{none}</>
  return (
    <time dateTime={at}>
      <span className="whitespace-nowrap">{formatWatDate(at)}</span>{' '}
      <span className="whitespace-nowrap text-muted-foreground">{formatWatTime(at)}</span>
    </time>
  )
}

/** A certificate's state as a pill: its status in words, or Expired. */
export function CertificatePill({
  status,
  expiresAt,
  now,
}: {
  status: string | null | undefined
  expiresAt: string | null | undefined
  now: Date
}) {
  const state = certificateState(status, expiresAt, now)
  return (
    <AdminStatusPill
      value={state.value}
      labels={{ [state.value]: state.label }}
      tone={state.tone}
    />
  )
}

/** The buyer, linked by id — never by email (N13); B10 reads no customer details. */
export function AccountLink({ userId }: { userId: string | null | undefined }) {
  if (!userId) return <span className="text-muted-foreground">—</span>
  return (
    <Link href={adminHref.customer(userId)} className={LINK}>
      Account {shortId(userId)}
    </Link>
  )
}

/** A notice above a list or a section: what was not done, and why. */
export function Notice({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex gap-2.5 rounded-xl border border-border bg-background/80 px-3.5 py-3 text-sm/6 text-foreground',
        className,
      )}
    >
      <Info className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 text-pretty">{children}</div>
    </div>
  )
}
