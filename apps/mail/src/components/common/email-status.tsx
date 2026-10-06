import type { EmailStatus } from '@dr/shared/mail'
import { StatusPill, type Tone } from './status-pill'

/** An email's status in words and tone (MAIL-SPEC §6), for the log and the email page. */
export const EMAIL_STATUS: Record<EmailStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  bounced: { label: 'Bounced', tone: 'danger' },
  complained: { label: 'Marked as spam', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  suppressed: { label: 'Suppressed', tone: 'warning' },
  canceled: { label: 'Canceled', tone: 'neutral' },
}

export function EmailStatusPill({ status }: { status: EmailStatus }) {
  const { label, tone } = EMAIL_STATUS[status]
  return <StatusPill tone={tone}>{label}</StatusPill>
}
