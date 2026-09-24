import type { LocalStatus } from '@dr/shared'
import { expiryUrgency } from '@dr/shared'
import { cn } from '@/lib/utils'

/**
 * Lifecycle status, rendered so urgency is visible at a glance (PRD UX-8).
 * Colour is never the only signal — the label carries the meaning for
 * screen readers and for anyone who cannot distinguish the hues. The label is
 * in the foreground colour: the status hues are too light for 12px text
 * (2:1 against their own tint), so they colour the dot, tint and border.
 */
export const STATUS_LABEL: Record<LocalStatus, string> = {
  pending: 'Registering',
  active: 'Active',
  expired_grace: 'Expired',
  redemption: 'Redemption',
  pending_delete: 'Pending delete',
  released: 'Released',
  transferred_away: 'Transferred away',
  pending_verification: 'Verification required',
  transfer_requested: 'Transfer requested',
  transfer_pending: 'Transfer in progress',
  transfer_rejected: 'Transfer rejected',
  transfer_cancelled: 'Transfer cancelled',
  registration_failed: 'Registration failed',
  closed: 'Closed',
}

const STATUS_TONE: Record<LocalStatus, string> = {
  pending:
    'bg-status-pending/15 text-foreground border-status-pending/30 [--dot:var(--status-pending)]',
  active:
    'bg-status-active/15 text-foreground border-status-active/30 [--dot:var(--status-active)]',
  expired_grace:
    'bg-status-expired/15 text-foreground border-status-expired/30 [--dot:var(--status-expired)]',
  redemption:
    'bg-status-redemption/15 text-foreground border-status-redemption/30 [--dot:var(--status-redemption)]',
  pending_delete:
    'bg-status-redemption/15 text-foreground border-status-redemption/30 [--dot:var(--status-redemption)]',
  released:
    'bg-status-neutral/15 text-foreground border-status-neutral/30 [--dot:var(--status-neutral)]',
  transferred_away:
    'bg-status-neutral/15 text-foreground border-status-neutral/30 [--dot:var(--status-neutral)]',
  pending_verification:
    'bg-status-expiring/15 text-foreground border-status-expiring/30 [--dot:var(--status-expiring)]',
  transfer_requested:
    'bg-status-pending/15 text-foreground border-status-pending/30 [--dot:var(--status-pending)]',
  transfer_pending:
    'bg-status-pending/15 text-foreground border-status-pending/30 [--dot:var(--status-pending)]',
  transfer_rejected:
    'bg-status-expired/15 text-foreground border-status-expired/30 [--dot:var(--status-expired)]',
  transfer_cancelled:
    'bg-status-neutral/15 text-foreground border-status-neutral/30 [--dot:var(--status-neutral)]',
  registration_failed:
    'bg-status-expired/15 text-foreground border-status-expired/30 [--dot:var(--status-expired)]',
  closed:
    'bg-status-neutral/15 text-foreground border-status-neutral/30 [--dot:var(--status-neutral)]',
}

export type DomainStatusPillProps = {
  status: LocalStatus
  /** When supplied on an active domain, expiry urgency overrides the neutral "Active" tone. */
  daysUntilExpiry?: number
  className?: string
}

export function DomainStatusPill({ status, daysUntilExpiry, className }: DomainStatusPillProps) {
  const urgency = daysUntilExpiry === undefined ? null : expiryUrgency(daysUntilExpiry)

  const showsUrgency = status === 'active' && urgency !== null && urgency !== 'safe'
  const label = showsUrgency ? `Expires in ${daysUntilExpiry} days` : STATUS_LABEL[status]

  const tone = showsUrgency
    ? urgency === 'soon'
      ? 'bg-status-expiring/15 text-foreground border-status-expiring/30 [--dot:var(--status-expiring)]'
      : 'bg-status-expired/15 text-foreground border-status-expired/30 [--dot:var(--status-expired)]'
    : STATUS_TONE[status]

  return (
    <span
      data-testid="domain-status-pill"
      data-status={status}
      data-urgency={urgency ?? undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        tone,
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--dot)]" />
      {label}
    </span>
  )
}
