import { ADMIN_ACTIONS, type AdminActionId, type AdminRole, rank } from './actions'
import { ADMIN_ERROR_WORDS } from './errors'

/**
 * Every sentence the Supplier pages say about acting (docs/ADMIN-SPEC.md
 * §5.2 B6): the owner's three dialogs, word for word, and why a control is
 * not offered. Copy describes what the code does — nothing more (N9b).
 */

export const APPLY_PRICE_LIST = {
  title: 'Apply the price list now?',
  body: 'This is the weekly sync, run early: it writes only changes it trusts, refuses a listing that looks broken, and reports the rest. Site prices update on the next refresh.',
  confirm: 'Apply price list',
  cancel: 'Not now',
  done: 'Price list applied.',
} as const

export const APPLY_SSL_LIST = {
  title: 'Apply the SSL product list now?',
  body: 'This is the weekly SSL product sync, run early: it writes only changes it trusts, refuses a listing that looks broken, and reports the rest. It never changes which products are on sale. Site prices update on the next refresh.',
  confirm: 'Apply SSL product list',
  cancel: 'Not now',
  done: 'SSL product list applied.',
} as const

export const RECORD_TOPUP = {
  trigger: 'Record what it cost',
  title: 'Record what this top-up cost?',
  body: 'The naira paid for this ledger credit. A record is never overwritten: a mistake is corrected, and the first record stays in history.',
  rows: {
    credit: 'Ledger credit',
    paid: 'NGN paid',
    reference: 'Reference',
    rate: 'Effective rate',
  },
  confirm: 'Record top-up',
  cancel: 'Cancel',
  done: 'Top-up cost recorded.',
} as const

export const CORRECT_TOPUP = {
  trigger: 'Correct',
  title: 'Correct what this top-up cost?',
  body: 'The first record stays in history, marked as corrected.',
  confirm: 'Correct top-up',
  cancel: 'Cancel',
  done: 'Top-up corrected.',
} as const

/** The fields beside a top-up, before its dialog opens. */
export const TOPUP_FIELDS = {
  paid: 'NGN paid',
  paidHint: 'What the transfer to DomainNameAPI cost, in naira — for example 58,320.50.',
  paidInvalid: 'Enter the naira paid, more than zero, with at most two decimal places.',
  reference: 'Payment reference',
  referenceHint: "The bank or card reference, up to 80 characters. Don't include personal details.",
  referenceInvalid: 'Give the payment reference in 1 to 80 characters.',
} as const

export const TOPUPS_LIVE_ONLY =
  "Top-up costs are recorded on the live side only: the test side's credits are the sandbox's, not money we paid."

export const OWNER_ONLY = {
  catalogue: 'Only the owner previews and applies the price list.',
  topups: 'Only the owner records and corrects what a top-up cost.',
} as const

/** The live reads' own words (§5.2 B6). */
export const LIVE_BALANCE = {
  button: 'Read live balance',
  pending: 'Reading…',
  intro:
    'Asks DomainNameAPI now, through the gateway. Each read is written to the audit log; the snapshot beside it is the gateway’s own, every 15 minutes.',
} as const

export const LIVE_LEDGER = {
  heading: 'Search the live ledger',
  intro:
    "Reads DomainNameAPI's own statement now, through the gateway. The search is sent in the request, never in the page's address, and each search is written to the audit log.",
  button: 'Search the live ledger',
  pending: 'Searching…',
  empty: 'DomainNameAPI lists no entries for this search.',
} as const

/**
 * Why an admin is not offered a control, or null when they are: a test
 * administrator for an action never open to one (the words SQL would give,
 * TEST_ADMIN), else the owner-only words, else the role words. SQL decides
 * either way; this only spares a refused round trip.
 */
export function notOfferedWords(
  admin: { role: AdminRole; testOnly: boolean },
  action: AdminActionId,
  ownerOnlyWords?: string,
): string | null {
  const tier = ADMIN_ACTIONS[action]
  if (admin.testOnly && tier.testRule === 'never') return ADMIN_ERROR_WORDS.TEST_ADMIN ?? null
  if (rank(admin.role) >= rank(tier.minRole)) return null
  if (tier.minRole === 'owner' && ownerOnlyWords) return ownerOnlyWords
  return ADMIN_ERROR_WORDS.ROLE ?? null
}
