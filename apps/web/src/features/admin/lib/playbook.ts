/**
 * docs/DEPLOY.md §6 "When an alert arrives", as data (ADMIN-SPEC §5.1): what
 * each code means, what to do, and which dashboard buttons belong to it. The
 * SQL editor stays the fallback for what the dashboard does not do (D20).
 */

export type PlaybookOffer =
  | 'approve_refund'
  | 'retry_refund'
  | 'cancel_refund'
  | 'record_manual_refund'
  | 'check_flutterwave'
  | 'retry_job'
  | 'fail_job'
  | 'read_registry'
  | 'read_transfer_state'
  | 'check_renewable'
  | 'resolve_incident'

export type PlaybookEntry = Readonly<{
  meaning: string
  next: string
  offers: readonly PlaybookOffer[]
}>

const entry = (meaning: string, next: string, offers: PlaybookOffer[]): PlaybookEntry => ({
  meaning,
  next,
  offers,
})

const LOOK_AT_THE_CHARGE = 'Look at the charge in the Flutterwave dashboard before anything else.'

export const PLAYBOOK: Readonly<Record<string, PlaybookEntry>> = {
  OVER_SINGLE_LIMIT: entry(
    'The refund is above the automatic limit for one refund, so it waits for a person.',
    'Check the order, then approve it — or keep it held.',
    ['approve_refund'],
  ),
  OVER_DAILY_LIMIT: entry(
    'Refunds sent in the last 24 hours plus this one are above the daily automatic limit.',
    'Check the order, then approve it — or keep it held until tomorrow.',
    ['approve_refund'],
  ),
  REGISTERED_AT_REGISTRY: entry(
    'The line failed here, but the registry has the domain in our account and no other customer here holds it.',
    'Don’t refund. Retry the registration job: it reads the registry, records the domain for the customer and cancels the refund.',
    ['retry_job', 'read_registry'],
  ),
  CHARGE_NOT_OURS: entry(
    'The charge at Flutterwave does not match our record — another reference, amount or currency. A refund is never sent to a charge that is not provably this order’s.',
    `Don’t refund. ${LOOK_AT_THE_CHARGE} If the row looks tampered with, rotate SUPABASE_SECRET_KEY. Cancel the refund once understood.`,
    ['cancel_refund'],
  ),
  CHARGE_NOT_FOUND: entry(
    'Flutterwave has no such charge for this key.',
    `Don’t refund. ${LOOK_AT_THE_CHARGE} Cancel the refund once understood.`,
    ['cancel_refund'],
  ),
  CHARGEBACK_ON_CHARGE: entry(
    'The customer disputed the charge with their bank.',
    'Answer the dispute in Flutterwave; refunding as well could pay them twice. Cancel the refund once it is settled.',
    ['cancel_refund'],
  ),
  REFUND_OUTCOME_UNKNOWN: entry(
    'A refund may already have been sent: the answer to the last attempt was lost.',
    `${LOOK_AT_THE_CHARGE} Refunded: record it, after checking it from here. Not refunded: retry.`,
    ['check_flutterwave', 'record_manual_refund', 'retry_refund'],
  ),
  UNTRACKED_REFUND_AT_PROVIDER: entry(
    'Flutterwave shows a refund on this charge that we did not send.',
    `${LOOK_AT_THE_CHARGE} Someone may have refunded by hand: record it after checking it from here.`,
    ['check_flutterwave', 'record_manual_refund', 'retry_refund'],
  ),
  ALREADY_AT_PROVIDER: entry(
    'Flutterwave already holds a refund for this charge.',
    `${LOOK_AT_THE_CHARGE} Refunded: record it. Not refunded: retry.`,
    ['check_flutterwave', 'record_manual_refund', 'retry_refund'],
  ),
  AMOUNT_MISMATCH: entry(
    'Flutterwave refunded a different amount from the one asked for; its reference is kept.',
    'Check the refund in the dashboard. If the right money went back, record it; otherwise ask before doing anything.',
    ['check_flutterwave', 'record_manual_refund'],
  ),
  PROVIDER_REFUND_FAILED: entry(
    'Flutterwave accepted the refund, then the money bounced.',
    'Fix the cause — often our Flutterwave balance — then retry. The bounced reference is kept and the retry gets a new one.',
    ['retry_refund'],
  ),
  INSUFFICIENT_BALANCE: entry(
    'Our Flutterwave balance cannot cover the refund.',
    'Top up, or wait for settlement: it retries by itself.',
    [],
  ),
  PAYMENT_NOT_VERIFIED: entry(
    'A line was about to be registered, but Flutterwave does not confirm the charge behind it. Nothing was registered and nothing refunded.',
    'Retry re-reads the charge from Flutterwave. If it still can’t be confirmed, the owner closes it in the SQL editor (DEPLOY §6).',
    ['retry_job'],
  ),
  TRANSFER_OVERDUE: entry(
    'A transfer the registry accepted has not landed or been refused in 10 days.',
    'Read the transfer state. Landed: record it in the SQL editor (complete_transfer, DEPLOY §6). Refused: fail it.',
    ['read_transfer_state', 'fail_job'],
  ),
  CONTACTS_NOT_VISIBLE: entry(
    'The registry accepted new contacts but does not show them.',
    'Look at the domain’s contacts at the supplier. Showing the new ones: retry, which records them.',
    ['read_registry', 'retry_job'],
  ),
  NOT_RENEWABLE: entry(
    'The renewal line named a domain this account cannot renew on this side.',
    'Check renewability at the registry before anything else.',
    ['check_renewable'],
  ),
  SUPPLIER_TIMEOUT: entry(
    'The supplier did not answer in time: the outcome is unknown, never failed (N3).',
    'Read the registry. In our account: retry, which records it. Not there, after the last attempt: fail and refund.',
    ['read_registry', 'retry_job', 'fail_job'],
  ),
}

/** Prefixes: `FLW_HTTP_…` and its kin share one entry. */
const PREFIXES: readonly [string, PlaybookEntry][] = [
  [
    'FLW_HTTP_',
    entry(
      'Flutterwave refused the refund.',
      'Read the code and fix the cause — often our Flutterwave balance — then retry.',
      ['retry_refund'],
    ),
  ],
]

export const NO_PLAYBOOK: PlaybookEntry = entry(
  'No playbook entry — read the job’s supplier calls first.',
  'Read the supplier calls and the timeline, then decide; ask before anything that moves money.',
  [],
)

export function playbookFor(code: string | null | undefined): PlaybookEntry {
  if (!code) return NO_PLAYBOOK
  const exact = PLAYBOOK[code]
  if (exact) return exact
  return PREFIXES.find(([prefix]) => code.startsWith(prefix))?.[1] ?? NO_PLAYBOOK
}
