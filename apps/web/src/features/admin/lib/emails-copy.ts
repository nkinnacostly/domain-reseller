import type {
  EmailCategory,
  NoticeStatus,
  NoticeType,
  OutboxStatus,
} from '@/features/admin/lib/emails-params'
import { formatCount } from '@/features/admin/lib/format'
import type { AdminSide } from '@/features/admin/lib/side'

/**
 * The emails page's words (docs/ADMIN-SPEC.md §5.2, B11). They say what the
 * outbox does and nothing more (N9b): the database queues every email, the
 * gateway sends what is waiting (CLAUDE.md §15), and ERRP notices are
 * compliance records that are never changed or deleted. A recipient is
 * only ever named masked, and a provider's error only with its addresses
 * replaced (`last_error_safe`).
 */

export const EMAILS_TITLE = 'Emails'

export const EMAILS_DESCRIPTION =
  'Every email the database queued on this side and what became of it, and the expiry notices kept as compliance records. Recipients are masked.'

export const TAB_LABEL = { outbox: 'Outbox', compliance: 'Compliance notices' } as const

export const sideWord = (side: AdminSide) => (side === 'test' ? 'Test' : 'Live')

// ── What an email is ──────────────────────────────────────────────────────

/** Each kind `@dr/shared/email` has a template for, in words. */
export const EMAIL_KIND_LABEL: Readonly<Record<string, string>> = {
  order_receipt: 'Order receipt',
  domain_registered: 'Domain registered',
  domain_renewed: 'Domain renewed',
  transfer_started: 'Transfer started',
  transfer_completed: 'Transfer completed',
  ssl_ready: 'Certificate ready to set up',
  ssl_issued: 'Certificate issued',
  order_line_failed: 'Order line failed',
  refund_sent: 'Refund sent',
  nameservers_changed: 'Nameservers changed',
  transfer_lock_changed: 'Transfer lock changed',
  contacts_changed: 'Contacts changed',
  auth_code_revealed: 'Transfer code shown',
  new_sign_in: 'New sign-in',
  password_changed: 'Password changed',
  two_factor_on: 'Two-factor turned on',
  two_factor_off: 'Two-factor turned off',
  expiry_notice: 'Expiry notice (ERRP)',
  undelegated_nudge: 'Not pointed anywhere yet',
  // MyDomainsHub Mail's notices (MAIL-SPEC §15, migration 58), sent from this outbox.
  mail_invite: 'Mail: team invitation',
  mail_cap_reached: 'Mail: sending limit reached',
  mail_past_due: 'Mail: payment past due',
  mail_plan_lapsed: 'Mail: plan moved to Free',
  mail_webhook_disabled: 'Mail: webhook turned off',
  mail_account_paused: 'Mail: sending paused',
  mail_sending_warning: 'Mail: sending warning',
}

/** A kind in words; one without a label shows as itself, spaced. */
export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return '—'
  return EMAIL_KIND_LABEL[kind] ?? kind.replace(/_/g, ' ')
}

export const CATEGORY_LABEL: Readonly<Record<EmailCategory, string>> = {
  transactional: 'Transactional',
  security: 'Security',
  compliance: 'Compliance',
}

/** The status chips, in words: the outbox's own statuses, then what became of a sent one. */
export const OUTBOX_STATUS_LABEL: Readonly<Record<OutboxStatus, string>> = {
  failed: 'Failed',
  pending: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  skipped: 'Skipped',
  bounced: 'Bounced',
  unconfirmed: 'No delivery report',
  complained: 'Reported as spam',
}

/** How long a security or compliance email may go without a report (the `email_unconfirmed` alert). */
export const UNCONFIRMED_HOURS = 24

export const STATUS_HINT: Partial<Record<OutboxStatus, string>> = {
  unconfirmed: `Security and compliance emails sent over ${UNCONFIRMED_HOURS} hours ago with no delivery report. Not counted as delivered.`,
  complained: 'The recipient reported the email as spam. It is never sent again.',
  bounced: 'The provider reported that the email bounced. It is never sent again.',
}

/** Why an email was deliberately not sent (`skip_reason`). */
export const SKIP_REASON_LABEL: Readonly<Record<string, string>> = {
  reserved_address: 'A reserved address (example.com, .test …): never sent to',
}

export function skipReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null
  return SKIP_REASON_LABEL[reason] ?? reason.replace(/_/g, ' ')
}

// ── Compliance notices ────────────────────────────────────────────────────

export const NOTICE_TYPE_LABEL: Readonly<Record<NoticeType, string>> = {
  errp_pre_35: 'One month before expiry',
  errp_pre_7: 'One week before expiry',
  errp_post: 'After expiry',
}

/** Each notice's window, as `admin_compliance_notices_v` words it. */
export const NOTICE_WINDOW: Readonly<Record<NoticeType, string>> = {
  errp_pre_35: '26–35 days before expiry',
  errp_pre_7: '4–10 days before expiry',
  errp_post: 'within 5 days after expiry',
}

export function noticeTypeLabel(type: string | null | undefined): string {
  if (!type) return '—'
  return NOTICE_TYPE_LABEL[type as NoticeType] ?? type.replace(/_/g, ' ')
}

export function noticeWindow(type: string | null | undefined): string | null {
  return type ? (NOTICE_WINDOW[type as NoticeType] ?? null) : null
}

/** A notice's delivery: `sent` means no final report has come back yet. */
export const NOTICE_STATUS_LABEL: Readonly<Record<NoticeStatus, string>> = {
  sent: 'No report yet',
  delivered: 'Delivered',
  bounced: 'Bounced',
}

export const COMPLIANCE_NOTE =
  'Expiry notices (ERRP) are compliance records, kept for three years exactly as they were sent. Nothing on this page changes, deletes or sends them. A bounced notice means the registrant must be reached another way.'

// ── The page's states ─────────────────────────────────────────────────────

export const OUTBOX_NOTE =
  'The database queues each email with the event it reports, and the gateway sends what is waiting. A failed email can be sent again; one that bounced or was reported as spam never is.'

export const TEST_SIDE_NOTE =
  'On the Test side most emails show as Skipped: test accounts use reserved addresses, which are never sent to.'

export const STATS_WINDOW_DAYS = 30
export const STATS_HEADING = `Last ${STATS_WINDOW_DAYS} days`
export const STATS_ERROR = "The email figures couldn't be loaded."
export const LIST_ERROR = "The emails couldn't be loaded."
export const NOTICES_ERROR = "The compliance notices couldn't be loaded."

export const NO_EMAILS = (side: AdminSide) => `No emails on the ${sideWord(side)} side yet`
export const NO_EMAILS_BODY =
  'An email appears here when an order, a domain event, a refund or a sign-in queues one.'
export const NO_MATCH = 'No emails match these filters'
export const NO_NOTICES = (side: AdminSide) =>
  `No expiry notices sent on the ${sideWord(side)} side yet`
export const NO_NOTICES_BODY =
  'A notice is recorded here once it is sent: 26–35 days before a domain expires, 4–10 days before, and within 5 days after.'
export const NO_NOTICE_MATCH = 'No notices match these filters'

export const emailCount = (count: number) =>
  count === 1 ? '1 email' : `${formatCount(count)} emails`
export const noticeCount = (count: number) =>
  count === 1 ? '1 notice' : `${formatCount(count)} notices`

// ── Send again (`email.requeue`, operator, standard tier) ─────────────────

export const SEND_AGAIN = {
  trigger: 'Send again',
  title: 'Send this email again?',
  body: "It goes back in the queue as Waiting, with its attempts reset, and the gateway's email sender takes it on its next run. If whatever stopped it is still wrong, it fails again and shows here as Failed.",
  confirmLabel: 'Send again',
  cancelLabel: 'Not now',
  done: 'Queued to send again. It shows as Waiting until the sender takes it.',
} as const

/** Why a failed email offers no "Send again" (the wrapper refuses the same: BOUNCED, COMPLAINED). */
export const NOT_SENT_AGAIN = {
  bounced: 'Bounced: never sent again.',
  complained: 'Reported as spam: never sent again.',
  role: 'An operator or the owner can send it again.',
} as const

export const tries = (attempts: number) => (attempts === 1 ? '1 try' : `${attempts} tries`)
