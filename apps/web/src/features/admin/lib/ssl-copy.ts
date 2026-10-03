import type { AdminSslStatus } from '@dr/shared/admin'
import { formatWat, formatWatDate, formatWatTime } from '@/features/admin/lib/format'
import type { AdminSide } from '@/features/admin/lib/side'
import type { Tone } from '@/features/admin/lib/tone'

/**
 * The certificate pages' words (docs/ADMIN-SPEC.md §5.2, B10), in one place
 * so tests hold them exactly. They say what is so and what to do next, and
 * describe nothing the product does not do (N9b). Term wording is never
 * written here: it comes from `SSL_TERM` (@dr/shared/ssl) — a certificate
 * lasts at most 200 days, so nothing here calls it valid for a year.
 *
 * The supplier's status word is never shown as sent (N10): a word we know is
 * put in ours, and one we do not is said to be unknown.
 */

export const sideWord = (side: AdminSide) => (side === 'test' ? 'Test' : 'Live')

export const SSL_DESCRIPTION =
  'Every certificate on this side: where it stands, its set-up and its expiry. Open one for its jobs, supplier calls and a status read from DomainNameAPI.'

// ── Where a certificate stands ─────────────────────────────────────────────

/** Our words for `ssl_certificates.status` (migration 39). */
export const CERTIFICATE_STATUS_LABEL: Record<string, string> = {
  pending: 'Ordering',
  awaiting_setup: 'Waiting for set-up',
  setting_up: 'Sending set-up',
  awaiting_validation: 'Waiting for approval',
  issued: 'Issued',
  reissuing: 'Reissuing',
  revoked: 'Revoked',
  cancelled: 'Cancelled',
  failed: 'Not ordered',
}

const STATUS_TONE: Record<string, Tone> = {
  pending: 'info',
  awaiting_setup: 'info',
  setting_up: 'info',
  awaiting_validation: 'info',
  issued: 'ok',
  reissuing: 'info',
  revoked: 'danger',
  cancelled: 'neutral',
  failed: 'danger',
}

/** A certificate this close to its expiry is worth reissuing (the customer's page says so too). */
export const EXPIRY_SOON_DAYS = 30

const DAY_MS = 86_400_000

/** Whole days until an expiry (negative once past); null without a date. */
export function daysUntil(at: string | null | undefined, now: Date): number | null {
  if (!at) return null
  const time = new Date(at).getTime()
  if (Number.isNaN(time)) return null
  return Math.floor((time - now.getTime()) / DAY_MS)
}

/**
 * The pill for a certificate: its status in words, except an issued one past
 * its expiry, which says Expired. An issued one close to expiry keeps its
 * word and is tinted as a warning — the words carry the meaning (S8).
 */
export function certificateState(
  status: string | null | undefined,
  expiresAt: string | null | undefined,
  now: Date,
): { value: string; label: string; tone: Tone } {
  const value = status ?? ''
  if (value === 'issued') {
    const days = daysUntil(expiresAt, now)
    if (days !== null && new Date(expiresAt ?? '').getTime() <= now.getTime()) {
      return { value: 'expired', label: 'Expired', tone: 'danger' }
    }
    if (days !== null && days <= EXPIRY_SOON_DAYS) {
      return { value, label: 'Issued', tone: 'warning' }
    }
  }
  return {
    value,
    label: CERTIFICATE_STATUS_LABEL[value] ?? (value.replace(/_/g, ' ') || '—'),
    tone: STATUS_TONE[value] ?? 'neutral',
  }
}

/** Where a certificate stands, in a sentence, for the top of its page. */
export const STATUS_SENTENCE: Record<string, string> = {
  pending:
    'Paid. Its order job buys it from DomainNameAPI; once bought, it waits for the customer’s set-up.',
  awaiting_setup:
    'Bought. Waiting for the customer to send the set-up: a certificate request (CSR), the approval address and the server type.',
  setting_up: 'The customer sent the set-up. A job passes it to DomainNameAPI.',
  awaiting_validation:
    'Set up. The certificate authority emailed the approval address, and issues the certificate once someone there approves.',
  issued: 'Issued. The customer downloads it from their certificate page.',
  reissuing:
    'A reissue is on its way: a job asks DomainNameAPI for a new certificate under the same subscription.',
  revoked: 'Revoked by the certificate authority.',
  cancelled: 'Cancelled at DomainNameAPI.',
  failed: 'Not ordered: nothing was bought. A refund for its line, if one was queued, is below.',
}

export function statusSentence(status: string | null | undefined): string {
  return (
    (status && STATUS_SENTENCE[status]) ||
    'This status has no words here yet. Read the certificate’s jobs and supplier calls.'
  )
}

/** When it expires, in words: "3 Apr 2027 (in 182 days)", "Expired on 3 Apr 2027". */
export function expiryWords(expiresAt: string | null | undefined, now: Date): string {
  const days = daysUntil(expiresAt, now)
  if (days === null) return 'Not issued yet'
  const date = formatWatDate(expiresAt)
  if (new Date(expiresAt ?? '').getTime() <= now.getTime()) return `Expired on ${date}`
  if (days === 0) return `${date} (today)`
  return `${date} (in ${days} ${days === 1 ? 'day' : 'days'})`
}

// ── The supplier's word ────────────────────────────────────────────────────

/** The words DomainNameAPI's SSL service uses (sandbox, 2 Oct 2026; apps/gateway/src/ssl/status.ts). */
const SUPPLIER_WORD: Record<string, string> = {
  waitingforinstall: 'Waiting for set-up',
  waitingforvalidation: 'Waiting for approval',
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
  // The gateway's own record when the supplier finds nothing under the name.
  notfound: 'Not found at DomainNameAPI',
}

/** Our words for a supplier status word, or null for one we do not know. */
export function supplierWordLabel(word: string | null | undefined): string | null {
  const key = String(word ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '')
  return SUPPLIER_WORD[key] ?? null
}

/**
 * The supplier's last word, as the page says it — never as sent (N10). A
 * word the gateway could not place (`status_unrecognised_since`) says since
 * when: the certificate's own status has not moved since then.
 */
export function supplierWordText(
  word: string | null | undefined,
  unrecognisedSince: string | null | undefined,
): string {
  if (!word) return 'Not read yet'
  const words = supplierWordLabel(word) ?? 'Not a word we know'
  return unrecognisedSince ? `${words} (since ${formatWat(unrecognisedSince)})` : words
}

/** Why a certificate's status is stuck on a word the gateway could not place, and what follows. */
export function unrecognisedHint(word: string | null | undefined): string {
  return supplierWordLabel(word) === 'Not found at DomainNameAPI'
    ? 'DomainNameAPI found no certificate under this name. Its status here stays as it was; after a day this raises an alert.'
    : 'DomainNameAPI sent a status word we don’t know. It is kept as sent and never guessed; its status here stays as it was, and after a day this raises an alert that names the word.'
}

// ── Set-up ─────────────────────────────────────────────────────────────────

export const WEB_SERVER_LABEL: Record<string, string> = {
  apache: 'Apache',
  iis: 'Microsoft IIS',
}

export const VALIDATION_LABEL: Record<string, string> = {
  email: 'Approval email',
}

export const NOT_SET_UP = 'Not sent yet'

export const PRIVATE_KEY_NOTE =
  'The private key is never stored or shown here: the customer keeps it on their server.'

export const NOT_ISSUED_TEXT =
  'No certificate text yet: it is stored once the certificate authority issues the certificate.'

// ── Reading the supplier now ───────────────────────────────────────────────

export const CHECK_STATUS_LABEL = 'Check status now'

export const CHECK_STATUS_INTRO =
  'Reads this certificate from DomainNameAPI now. Nothing about the certificate changes; the read is recorded in the audit log.'

export const CHECK_ROLE_WORDS = 'Your admin role can’t read DomainNameAPI. Ask an operator.'

/** What a status read found, in one line (§4.3 `AdminSslStatus`). */
export function statusReadWords(result: AdminSslStatus): string {
  const at = `Read at ${formatWatTime(result.readAt)}`
  if (result.outcome === 'not_found')
    return `${at}: DomainNameAPI has no certificate under this name`
  const word = supplierWordLabel(result.status) ?? 'a status word we don’t know'
  const parts: string[] = []
  if (result.isIssued === true) parts.push('issued')
  else if (result.isConfigured === true) parts.push('set up, not issued yet')
  else if (result.isConfigured === false) parts.push('not set up yet')
  const expires = result.certificateExpiresAt ?? result.validUntil
  if (expires) parts.push(`the certificate expires ${formatWatDate(expires)}`)
  if (result.subscriptionEndsAt) {
    parts.push(`the subscription ends ${formatWatDate(result.subscriptionEndsAt)}`)
  }
  return parts.length > 0 ? `${at}: ${word} — ${parts.join('; ')}` : `${at}: ${word}`
}

/** The last status read an admin made, from the calls on record. */
export function lastReadWords(last: { createdAt: string; outcome: string } | null): string {
  if (!last) return 'No admin has read its status from DomainNameAPI yet.'
  const found =
    last.outcome === 'ok'
      ? 'found'
      : last.outcome === 'not_found'
        ? 'not found'
        : last.outcome.replace(/_/g, ' ')
  return `Last read by an admin: ${formatWat(last.createdAt)} (${found}).`
}

// ── Lists, searches and states ─────────────────────────────────────────────

export const SEARCH_HINT =
  'A certificate’s name, such as example.com or *.example.com. Find a customer by email on the Customers page.'

/** The browser's own message when an email is typed into the box: the form is never sent. */
export const SEARCH_NOT_EMAIL =
  'Certificates are not searched by email. Find the customer on the Customers page.'

export const EMAIL_REFUSED =
  'Nothing was searched: certificates are never looked up by email, because an email in a link stays in browser history and logs. Find the customer on the Customers page.'

export const UNKNOWN_SEARCH =
  'Nothing was searched: that isn’t a certificate’s name, such as example.com or *.example.com.'

export const UNRECOGNISED_FILTER = 'Unknown supplier word only'
export const UNRECOGNISED_FILTER_HINT =
  'Certificates whose last word from DomainNameAPI is not one we know.'

export const NO_CERTIFICATES = (side: AdminSide) =>
  `No certificates on the ${sideWord(side)} side yet.`
export const NO_CERTIFICATES_BODY = (side: AdminSide) =>
  side === 'test'
    ? 'Test certificates appear here once someone buys one with Flutterwave’s test keys.'
    : 'Certificates appear here as customers buy them.'
export const NO_MATCH = 'No certificates match these filters.'
export const LIST_ERROR = 'The certificates couldn’t be loaded.'
export const STATS_ERROR = 'The certificate figures couldn’t be read.'

export const PAID_HEADING = 'Paid, no certificate'
export const PAID_NOTE =
  'A paid certificate line gets its certificate and order job in the payment’s own transaction, so a line listed here needs a person. Lines paid in the last 5 minutes are not counted. Nothing on this page creates a certificate.'
export const PAID_NONE = 'Every paid certificate line on this side has its certificate.'
export const PAID_ERROR = 'The paid certificate lines couldn’t be read.'

export const CERTIFICATE_NOT_FOUND = (side: AdminSide) =>
  `No certificate with this id on the ${sideWord(side)} side.`
export const CERTIFICATE_NOT_FOUND_BODY =
  'It may be on the other side, or the link may be wrong. Switch sides above, or find it in the list.'
export const CERTIFICATE_ERROR = 'This certificate couldn’t be loaded.'
export const SECTION_ERROR = 'This part of the certificate couldn’t be loaded.'

export const NO_JOBS = 'No jobs for this certificate.'
export const NO_REFUNDS = 'No refunds for this certificate’s line.'
export const NO_CALLS = 'No supplier calls are recorded for this certificate.'
export const NO_LINE = 'Its order line couldn’t be found on this side.'

/** A supplier call's outcome in words (migration 13's five). */
export const CALL_OUTCOME_LABEL: Record<string, string> = {
  ok: 'OK',
  not_found: 'Not found',
  rejected: 'Refused',
  blocked: 'Blocked',
  unknown: 'Unknown',
}

export function callOutcomeTone(outcome: string): Tone {
  switch (outcome) {
    case 'ok':
      return 'ok'
    case 'not_found':
      return 'info'
    case 'unknown':
      return 'warning'
    case 'rejected':
    case 'blocked':
      return 'danger'
    default:
      return 'neutral'
  }
}
