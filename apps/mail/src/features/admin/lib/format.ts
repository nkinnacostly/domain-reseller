import type { Tone } from '@/components/common/status-pill'
import { formatKobo } from '@/features/billing/lib/money'

/**
 * How Mail's admin words what SQL answers (MAIL-SPEC §7, §10). Every label
 * is words, so colour is never the only signal (S8); an unknown code shows as
 * itself rather than as a guess.
 */

const count = new Intl.NumberFormat('en-NG')

export const formatCount = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : count.format(n)

/** Parts per million as a percentage: 43,000 → "4.3%", 523 → "0.052%". */
export function formatPpm(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm)) return '—'
  const percent = ppm / 10_000
  const digits = percent !== 0 && percent < 0.1 ? 3 : percent < 1 ? 2 : 1
  return `${Number(percent.toFixed(digits))}%`
}

const lagos = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** A moment in Lagos time: "6 Oct 2026, 14:05". */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '—' : lagos.format(at)
}

export const STATE_TONE: Record<string, { label: string; tone: Tone }> = {
  sandbox: { label: 'Sandbox', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
}

export const stateOf = (state: string) =>
  STATE_TONE[state] ?? { label: state, tone: 'neutral' as Tone }

/** The tenant's sending status, as SES reports it (§4.2). */
export const SES_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Tenant not made yet', tone: 'neutral' },
  enabled: { label: 'SES sending', tone: 'success' },
  disabled: { label: 'Paused at SES', tone: 'danger' },
  reinstated: { label: 'Reinstated by SES', tone: 'success' },
}

export const sesStatusOf = (status: string) =>
  SES_STATUS[status] ?? { label: status, tone: 'neutral' as Tone }

/** state_reason codes (migration 51): why an account is paused or closed. */
export const STATE_REASON: Record<string, string> = {
  paused_bounce_rate: 'Paused by our threshold: bounces',
  paused_complaint_rate: 'Paused by our threshold: complaints',
  paused_by_admin: 'Paused by an admin',
  paused_by_ses: 'Paused by SES (AWS)',
  rejected_at_review: 'Not approved at review',
}

export const stateReasonOf = (reason: string | null) =>
  reason ? (STATE_REASON[reason] ?? reason) : null

export const FINDING_KIND: Record<string, string> = {
  bounce_warning: 'Bounces over our warning level',
  complaint_warning: 'Complaints over our warning level',
  bounce_pause: 'Bounces over our pause level',
  complaint_pause: 'Complaints over our pause level',
  admin_pause: 'Paused by an admin',
  sending_paused: 'SES paused sending',
  ses_paused: 'SES paused the tenant; held here until an owner resumes it',
}

export const findingKindOf = (kind: string) => FINDING_KIND[kind] ?? kind.replaceAll('_', ' ')

/** mail.billing_incidents kinds (migrations 50, 54), and what a person does about each. */
export const INCIDENT_KIND: Record<string, { label: string; todo: string }> = {
  unknown_reference: {
    label: 'Unknown reference',
    todo: 'A charge named an MDM- reference no checkout has. Find it in Flutterwave and refund it.',
  },
  tx_ref_mismatch: {
    label: 'Charge for another checkout',
    todo: 'A charge was presented for a checkout it is not for (a replayed or mistyped return). Nothing was applied from it there.',
  },
  mode_mismatch: {
    label: 'Test and live crossed',
    todo: 'A test charge met a live checkout, or the other way round. Nothing was applied; check the keys.',
  },
  currency_mismatch: {
    label: 'Not in naira',
    todo: 'A successful charge in another currency. Nothing was applied; refund it in Flutterwave.',
  },
  unapplied_charge: {
    label: 'Paid for nothing',
    todo: 'Recorded, but it paid for nothing. Refund it in Flutterwave.',
  },
  subscription_not_canceled: {
    label: 'Subscription still charging',
    todo: 'Flutterwave may charge this card again. Cancel the subscription in Flutterwave.',
  },
  unrecorded_payment: {
    label: 'Payment not recorded',
    todo: 'Flutterwave confirmed it, but it is not recorded here. Record it, or refund it.',
  },
  unexpected_failed_charge: {
    label: 'Failed charge out of turn',
    todo: 'A failed charge far from the period’s end: not taken as a failed renewal. Check who made it.',
  },
  // Migration 56: one checkout charge started two Flutterwave subscriptions (7 Oct 2026).
  duplicate_charge: {
    label: 'Charged twice for one month',
    todo: 'A second renewal arrived for a month already paid. It was recorded but not applied, and Mail has no refund flow, so nothing was refunded. Refund this charge in Flutterwave.',
  },
  duplicate_subscription: {
    label: 'Duplicate subscription',
    todo: 'One payment started more than one Flutterwave subscription. Mail keeps the earliest and cancels the others, asking again every hour until Flutterwave confirms. Check in Flutterwave that only the kept one is active, and refund anything the others charged (each is its own “Charged twice for one month” incident).',
  },
}

/**
 * How an incident is closed. Mail's admin has no resolve action yet (a
 * resolved incident is one with `resolved_at` set, migration 50), so the page
 * says who closes it and how, and that its alert stops then (migration 54).
 */
export const INCIDENT_CLOSING =
  'Closing an incident: there is no button for it yet. Once it is dealt with in Flutterwave (the charge refunded, or the subscription cancelled), ask the owner to close it in the database: in Supabase’s SQL editor they set resolved_at and resolved_by on its row in mail.billing_incidents. Its ops alert stops then.'

export const incidentKindOf = (kind: string) =>
  INCIDENT_KIND[kind] ?? { label: kind.replaceAll('_', ' '), todo: 'Look it up in Flutterwave.' }

/** An incident's detail as a line: its scalar facts, kobo shown as naira (N5). */
export function incidentDetailLine(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .map(([key, value]) =>
      key.endsWith('_kobo') && typeof value === 'number' && Number.isSafeInteger(value)
        ? `${key.replace(/_kobo$/, '').replaceAll('_', ' ')} ${formatKobo(value)}`
        : `${key.replaceAll('_', ' ')} ${String(value)}`,
    )
    .join(', ')
}

const idText = (value: unknown) =>
  typeof value === 'string' && /^[0-9][0-9, ]{0,99}$/.test(value) ? value : null

/**
 * An incident's facts in plain words, with Flutterwave's ids, for the kinds
 * migration 56 records (its detail keys); the generic line for the rest, and
 * for a detail without the keys it should have.
 */
export function incidentFacts(
  kind: string,
  detail: Record<string, unknown>,
  providerReference: string | null,
): string {
  if (kind === 'duplicate_charge') {
    const charge = idText(detail.transaction_id) ?? idText(providerReference)
    const first = idText(detail.period_transaction_id)
    const amount = detail.amount_kobo
    if (charge && first && typeof amount === 'number' && Number.isSafeInteger(amount)) {
      return `Charge ${charge} (${formatKobo(amount)}) came after charge ${first} had already paid for the month. Not refunded automatically: Mail has no refund flow.`
    }
  }
  if (kind === 'duplicate_subscription') {
    const kept = idText(detail.kept_subscription_id)
    const others = idText(detail.duplicate_subscription_ids)
    const charge = idText(providerReference)
    if (kept && others && charge) {
      return `Payment ${charge} started Flutterwave subscriptions ${kept} and ${others}. Kept ${kept}; Mail cancels ${others}, asking hourly until Flutterwave confirms.`
    }
  }
  return incidentDetailLine(detail)
}

export const RESOLUTION: Record<string, string> = {
  cleared: 'Cleared: the rates fell',
  resumed: 'Closed by a resume',
  closed: 'Closed with the account',
}

export const TENANT_ACTION: Record<string, string> = {
  DISABLED: 'Pause the tenant at SES',
  ENABLED: 'Resume the tenant at SES',
}

export const TENANT_ACTION_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  claimed: { label: 'Being applied', tone: 'info' },
  applied: { label: 'Applied at SES', tone: 'success' },
  canceled: { label: 'Withdrawn', tone: 'neutral' },
}

export const DOMAIN_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  removed: { label: 'Removed', tone: 'neutral' },
}

export const domainStatusOf = (status: string) =>
  DOMAIN_STATUS[status] ?? { label: status, tone: 'neutral' as Tone }

export const AUDIT_ACTION: Record<string, string> = {
  'mail.approve': 'Approve',
  'mail.reject': 'Reject',
  'mail.pause': 'Pause',
  'mail.resume': 'Resume',
  'mail.cap_override': 'Cap override',
}

export const AUDIT_OUTCOME: Record<string, { label: string; tone: Tone }> = {
  ok: { label: 'Done', tone: 'success' },
  refused: { label: 'Refused', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  intent: { label: 'Noted', tone: 'info' },
}

/** A heartbeat's name without its prefix: `mail-worker:send` → "send". */
export const heartbeatLabel = (name: string) => name.replace(/^mail-worker:/, '')
