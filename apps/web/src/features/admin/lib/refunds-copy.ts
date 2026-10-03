import { formatNaira } from '@dr/shared'
import type { AdminFlwRefundCheck } from '@dr/shared/admin'
import type { CheckProblem, IncidentOutcome } from '@/features/admin/lib/refunds-rules'

/**
 * Every word the refund and incident dialogs say (ADMIN-SPEC §5.2 B3).
 * Each limit figure is built from `admin_refund_stats.limits` — the numbers
 * the database holds today — and never written here: a changed limit must
 * change the words with it (N9b). Amounts are integer kobo until this edge.
 */

export type RefundLimits = { singleKobo: number; dailyKobo: number; delayMinutes: number }

const NGN_KOBO = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * Naira as people write them: ₦19,672 for whole naira, ₦19,672.50 when
 * there are kobo. A refund of VAT-inclusive money rarely lands on a whole
 * naira, and two amounts that differ by kobo must not read the same.
 */
export function naira(kobo: number): string {
  return kobo % 100 === 0 ? formatNaira(kobo) : NGN_KOBO.format(kobo / 100)
}

// ── What a refund is for, and what happened to it ─────────────────────────

const LINE_KIND: Record<string, string> = {
  register: 'Registration of',
  renew: 'Renewal of',
  transfer: 'Transfer of',
  ssl: 'Certificate for',
}

const REASON_FOR: Record<string, string> = {
  duplicate_charge: 'A second charge for one order',
  overpayment: 'Paid more than the total',
  underpayment: 'Paid less than the total',
  empty_order: 'An order with nothing left to supply',
  registration_failed: 'A registration that failed',
  renewal_failed: 'A renewal that failed',
  transfer_failed: 'A transfer that failed',
  ssl_failed: 'A certificate that was not ordered',
}

/** "Registration of example.com", or what a charge refund is for. */
export function refundFor(
  reason: string,
  line: { domain: string; itemType: string } | null,
): string {
  if (line) return `${LINE_KIND[line.itemType] ?? 'Line for'} ${line.domain}`
  return REASON_FOR[reason] ?? reason.replace(/_/g, ' ')
}

const EVENT_TITLE: Record<string, string> = {
  queued: 'Queued',
  held: 'Held for approval',
  approved: 'Approved',
  retried: 'Sent again',
  sending: 'Sending to Flutterwave',
  provider_call: 'Flutterwave called',
  submitted: 'With Flutterwave',
  completed: 'Refunded',
  failed: 'Failed',
  needs_attention: 'Needs a person',
  cancelled: 'Cancelled',
}

const PEOPLE_ACTORS = new Set(['system', 'worker', ''])

/** A refund event's title: what happened, and who did it when a person did. */
export function eventTitle(event: string, actor: string): string {
  const title = EVENT_TITLE[event] ?? event.replace(/_/g, ' ')
  return PEOPLE_ACTORS.has(actor) ? title : `${title} · ${actor}`
}

/** The facts an event carries, in words: codes, references, attempts and notes. */
export function eventDetail(detail: Record<string, unknown>): string | null {
  const parts: string[] = []
  const text = (key: string) => {
    const value = detail[key]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null
  }
  const why = text('why')
  if (why) parts.push(why.replace(/_/g, ' '))
  const code = text('code')
  if (code) parts.push(`code ${code}`)
  const attempt = text('attempt')
  if (attempt) parts.push(`attempt ${attempt}`)
  const reference = text('provider_refund_id')
  if (reference) parts.push(`Flutterwave refund ${reference}`)
  const status = text('status')
  if (status) parts.push(`status ${status}`)
  const amount = detail.amount_kobo
  if (typeof amount === 'number') parts.push(naira(amount))
  const note = text('note')
  if (note) parts.push(`“${note}”`)
  return parts.length > 0 ? parts.join(' · ') : null
}

// ── Why a refund is held ──────────────────────────────────────────────────

/** The "Held because" row, from the code the database held it with. */
export function heldBecause(
  code: string | null,
  limits: RefundLimits,
  sent24hKobo: number,
): string | null {
  if (code === 'OVER_SINGLE_LIMIT') {
    return `Over the ${naira(limits.singleKobo)} automatic limit per refund`
  }
  if (code === 'OVER_DAILY_LIMIT') {
    return `Over the ${naira(limits.dailyKobo)} daily automatic limit — ${naira(sent24hKobo)} already sent in the last 24 hours`
  }
  return null
}

// ── 1. Approve ────────────────────────────────────────────────────────────

export function approveCopy(amountKobo: number) {
  return {
    title: 'Approve this refund?',
    body: "The worker sends it to the card or account that paid on its next run, after reading the charge back from Flutterwave. It stops if the charge isn't this order's.",
    confirmLabel: `Approve ${naira(amountKobo)} refund`,
    cancelLabel: 'Keep it held',
    success: 'Approved. The worker sends it on its next run.',
  } as const
}

// ── 2. Retry ──────────────────────────────────────────────────────────────

/** Asked whenever Flutterwave was already called for this refund (CHECK_PROVIDER). */
export const PROVIDER_CHECK = {
  id: 'provider',
  label: 'I checked the Flutterwave dashboard: no refund of this charge went through.',
} as const

export function retryCopy(amountKobo: number, limits: RefundLimits) {
  return {
    title: 'Send this refund again?',
    body: "Only after checking Flutterwave shows no refund for this charge. The worker reads the charge's refunds before sending.",
    warning: `Retrying approves it: the ${naira(limits.singleKobo)} per-refund and ${naira(limits.dailyKobo)} daily automatic limits won't hold it again.`,
    confirmLabel: `Retry ${naira(amountKobo)} refund`,
    cancelLabel: 'Not now',
    success: 'Queued again. The worker sends it on its next run.',
  } as const
}

// ── 3. Cancel ─────────────────────────────────────────────────────────────

export const NO_MONEY_CHECK = {
  id: 'noMoney',
  label: "We haven't returned this money through Flutterwave, and won't.",
} as const

export const CANCEL_NOTE_MAX = 300

export const CANCEL_COPY = {
  title: 'Cancel this refund?',
  body: "Use this only when we won't send this money back — for example, the customer's bank reversed the charge (a chargeback), so the money returned without us. If we sent it from the Flutterwave dashboard, use Record a Flutterwave refund instead. If the domain turned out to be registered, retry the registration job: that records it and cancels the refund.",
  noteLabel: 'What happened',
  confirmLabel: 'Cancel refund — nothing sent',
  cancelLabel: 'Keep refund',
  success: 'Cancelled. Nothing was sent.',
} as const

// ── 4. Record a Flutterwave refund ────────────────────────────────────────

export function recordCopy(amountKobo: number) {
  return {
    title: 'Record this Flutterwave refund?',
    body: `Nothing is sent. The customer's order page will show ${naira(amountKobo)} as refunded.`,
    confirmLabel: `Record ${naira(amountKobo)} as refunded`,
    cancelLabel: 'Cancel',
    success: 'Recorded as refunded.',
  } as const
}

export const CHECK_STEP = {
  heading: 'Record a Flutterwave refund',
  intro:
    'For money already returned from the Flutterwave dashboard. Check the refund from here first: it must be this charge, this amount, and completed.',
  idLabel: 'Flutterwave refund id',
  idHint: 'From the refund in the Flutterwave dashboard: letters, digits, - and _.',
  idInvalid: "That isn't a Flutterwave refund id.",
  button: 'Check with Flutterwave',
  pending: 'Checking…',
  /** Shown beside the record button until a check backs it. */
  needsCheck: 'Check the refund with Flutterwave first. A check is good for 15 minutes.',
  refundCharge: "The database also checks it is on this order's charge before it records anything.",
} as const

const STATE_WORDS: Record<AdminFlwRefundCheck['state'], string> = {
  done: 'completed',
  pending: 'not finished',
  failed: 'failed',
}

/** "Flutterwave refund 123: ₦19,672.50 on charge 456, completed — matches this refund". */
export function checkSummary(check: AdminFlwRefundCheck, matches: boolean, target: string): string {
  const charge = check.transactionId ? `on charge ${check.transactionId}` : 'on an unknown charge'
  const head = `Flutterwave refund ${check.flwRefundId}: ${naira(check.amountKobo)} ${charge}, ${STATE_WORDS[check.state]}`
  return matches ? `${head} — matches this ${target}` : head
}

/** Each way a check does not match, in words. */
export function checkProblemWords(problem: CheckProblem, target: string): string {
  switch (problem.kind) {
    case 'state':
      return problem.state === 'failed'
        ? 'Flutterwave says this refund failed, so no money went back.'
        : `Flutterwave hasn't finished this refund yet (${problem.status || 'no status'}). Check again once it completes.`
    case 'amount':
      return `It is for ${naira(problem.checkKobo)}, not this ${target}'s ${naira(problem.wantKobo)}.`
    case 'charge':
      return problem.checkTx
        ? `It is on charge ${problem.checkTx}, not this ${target}'s charge ${problem.wantTx || '(none recorded)'}.`
        : `Flutterwave didn't say which charge it is on, so it can't be matched to this ${target}.`
    case 'stale':
      return 'This check is over 15 minutes old. Check again.'
  }
}

// ── 5. Resolve an incident ────────────────────────────────────────────────

export const OUTCOME_LABEL: Record<IncidentOutcome, string> = {
  payment_recorded: 'The payment is now recorded',
  refund_completed: 'A refund for this order completed',
  flw_refund_verified: 'A Flutterwave refund I checked just now',
  handled_outside: 'Handled outside the dashboard',
}

export const HANDLED_OUTSIDE_CHECK = {
  id: 'confirmed',
  label:
    'I confirmed in Flutterwave that the customer has their money or their order, and recorded what happened in the SQL editor.',
} as const

export const RESOLVE_COPY = {
  title: 'Mark this incident resolved?',
  outcomeLegend: 'What happened?',
  ownerOnly: 'Owner only',
  reviewed: "This records that you've looked at it. Nothing is charged or refunded.",
  owed: 'Money is owed on this kind of incident. Say what settled it; the database checks the records before it marks it resolved.',
  pickRefund: 'Which refund',
  noCompletedRefund: 'No refund on this order has completed yet.',
  chooseFirst: 'Choose what happened first.',
  confirmLabel: 'Mark resolved',
  cancelLabel: 'Not yet',
  success: 'Marked resolved.',
} as const

export const INCIDENT_KIND_LABEL: Record<string, string> = {
  unrecorded_payment: 'Payment not recorded',
  refund_not_created: 'Refund not queued',
  currency_mismatch: 'Charged in another currency',
  mode_mismatch: 'Test and live crossed',
  underpayment: 'Paid less than the total',
  tx_ref_mismatch: 'Charge for another order',
  registered_after_refund: 'Registered after its refund',
}

/** What each kind means, for the incident's card. */
export const INCIDENT_KIND_MEANING: Record<string, string> = {
  unrecorded_payment:
    'Flutterwave confirms a charge for this order that could not be recorded here. The webhook and the payment sweeper try again; if it stays unrecorded, record it in the SQL editor (DEPLOY §6) or refund it.',
  refund_not_created:
    'A refund was owed but could not be queued, so nothing was sent. Look at the order and the charge, then settle it.',
  currency_mismatch:
    'A successful charge was not in naira, so it was not applied to the order. Nothing was refunded.',
  mode_mismatch:
    'A test payment was presented for a live order, or the reverse. Nothing was applied; check the charge in Flutterwave.',
  underpayment:
    'A successful charge was below the order total. It was not applied and its refund was queued.',
  tx_ref_mismatch:
    "A charge was presented for an order that isn't its own. Nothing was applied; look at it in Flutterwave.",
  registered_after_refund:
    'A line was registered while its refund was on its way. Check whether the customer has both the domain and the money.',
}
