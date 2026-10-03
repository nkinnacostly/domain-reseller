import type { CustomerAllowance } from '@/features/admin/lib/customers-data'
import type { AdminSide } from '@/features/admin/lib/side'

/**
 * The customers pages' words (docs/ADMIN-SPEC.md §5.2, B8), in one place so
 * tests hold them exactly. They describe what the pages do — masked by
 * default, a search sent in the request body, a reveal recorded each time —
 * and nothing they do not (N9b).
 */

export const sideWord = (side: AdminSide) => (side === 'test' ? 'Test' : 'Live')

/**
 * Searches and contact views an admin may make in an hour. SQL holds the
 * limit (`admin_lookup_rate_limited`, migration 40); this is its number, for
 * the hint only.
 */
export const LOOKUPS_PER_HOUR = 30

export const CUSTOMERS_DESCRIPTION =
  'Every account, with its email masked. Find one by exact email, order number or domain; contact details show only when you ask, and each look is recorded.'

// ── Stats ──

export const STATS_HEADING = 'Accounts'
export const STATS_HIDDEN = 'Not shown to test administrators.'
export const STATS_HIDDEN_BODY =
  'These totals count real accounts. A test administrator sees e2e test accounts only.'
export const STATS_NOTE =
  'Real accounts only: test addresses are left out. Buyers and holders count the live side, whichever side is shown.'
export const STATS_ERROR = 'The account totals couldn’t be loaded.'
export const SIGNUPS_TITLE = 'Sign-ups by day, last 30 days (WAT)'

// ── Search ──

export const SEARCH_HEADING = 'Find a customer'
export const SEARCH_LABEL = 'Email, order number or domain'
export const SEARCH_HINT = `The whole email address, order number (ND-…) or domain — not part of one. It is sent in the request, never in the page address, and each search is recorded without what you typed. ${LOOKUPS_PER_HOUR} searches and contact views an hour.`
export const SEARCH_TEST_ADMIN = 'Test administrators find e2e test accounts only.'
export const SEARCH_ROLE = 'Your admin role can’t look customers up. Ask the owner.'
export const SEARCH_TOO_SHORT = 'Type at least 3 characters.'
export const SEARCH_NO_MATCH = 'No customer matches that exactly.'
export const SEARCH_NO_MATCH_BODY =
  'Check it is the whole email address, order number or domain. Each search counts toward the hourly limit.'
export const SEARCH_FAILED = 'The search didn’t finish. Try again in a moment.'
export const SEARCH_FOUND = (n: number) =>
  `${n} ${n === 1 ? 'customer matches' : 'customers match'} exactly`
export const SEARCH_COUNTS = (testOnly: boolean) =>
  testOnly ? 'Domains and orders on the Test side.' : 'Domains and orders on the Live side.'

// ── The list ──

export const LIST_HEADING = 'All customers'
export const LIST_ERROR = 'The customers couldn’t be loaded.'
export const NO_CUSTOMERS = (testOnly: boolean) =>
  testOnly ? 'No e2e test accounts right now.' : 'No customers yet.'
export const NO_CUSTOMERS_BODY = (testOnly: boolean) =>
  testOnly
    ? 'Test administrators see e2e test accounts only; they appear while a test run is going.'
    : 'Accounts appear here as people sign up.'
export const NO_MATCH = 'No customers match these filters.'
export const LIST_COUNTS = (side: AdminSide) =>
  `Domains, orders and totals count the ${sideWord(side)} side.`

// ── One customer ──

export const CUSTOMER_NOT_FOUND = 'No customer with this id.'
export const CUSTOMER_NOT_FOUND_BODY =
  'The link may be wrong, or the account was deleted. Find the customer in the list.'
export const CUSTOMER_TEST_ADMIN = 'Not shown to test administrators.'
export const CUSTOMER_TEST_ADMIN_BODY =
  'Test administrators see e2e test accounts only. This account is not one.'
export const CUSTOMER_ERROR = 'This customer couldn’t be loaded.'
export const SECTION_ERROR = 'This part of the customer couldn’t be loaded.'

export const REVEAL_HEADING = 'Contact details'
export const REVEAL_TRIGGER = 'Show contact details'
export const REVEAL_TITLE = 'Show this customer’s contact details?'
export const REVEAL_BODY = 'Your view is recorded in the audit log.'
export const REVEAL_DONE = 'Contact details are shown on the page.'
export const REVEAL_HIDE = 'Hide contact details'
export const REVEAL_NOTE =
  'Hidden until you ask. Each view is recorded in the audit log, and what you see is cleared when you leave this page.'
export const REVEAL_SHOWN_NOTE =
  'Shown for this view only: cleared when you leave this page. Don’t copy it anywhere it would be kept.'
export const REVEAL_ROLE = 'Your admin role can’t see contact details. Ask the owner.'
export const REVEAL_UNREADABLE =
  'The view was recorded, but its details couldn’t be read. Ask again: it is a new view, and it is recorded too.'

export const CONTACT_LABEL = {
  email: 'Email',
  fullName: 'Full name',
  phone: 'Phone',
  businessName: 'Business name',
} as const

export const NOT_GIVEN = 'Not given'

// ── Tabs ──

/** What an order line bought, in words (order_items.item_type). */
export const LINE_KIND_LABEL: Record<string, string> = {
  register: 'Registration',
  renew: 'Renewal',
  transfer: 'Transfer in',
  ssl: 'Certificate',
}

/** The kinds an order's lines buy, each once, in a fixed order: "Registration, Certificate". */
export function kindsText(kinds: readonly string[]): string {
  const unique = [...new Set(kinds)]
  if (unique.length === 0) return 'No lines'
  const order = Object.keys(LINE_KIND_LABEL)
  return unique
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((kind) => LINE_KIND_LABEL[kind] ?? kind.replace(/_/g, ' '))
    .join(', ')
}

export const OVERVIEW_ACCOUNT_HEADING = 'Account'
export const OVERVIEW_SIDE_HEADING = (side: AdminSide) => `On the ${sideWord(side)} side`
export const ALLOWANCE_HEADING = 'New domains allowed'
export const ALLOWANCE_UNREAD = 'The daily allowance couldn’t be read.'

export const DOMAINS_HEADING = 'Domains'
export const DOMAINS_NOTE = (side: AdminSide) =>
  `This customer’s domains on the ${sideWord(side)} side, newest first, as our records hold them. Each one’s registry state is on its own page.`
export const NO_DOMAINS = (side: AdminSide) =>
  `No domains for this customer on the ${sideWord(side)} side.`

export const CERTIFICATES_HEADING = 'Certificates'
export const CERTIFICATES_NOTE = (side: AdminSide) =>
  `This customer’s certificates on the ${sideWord(side)} side, newest first. Each one’s set-up and checks are on its own page.`
export const NO_CERTIFICATES = (side: AdminSide) =>
  `No certificates for this customer on the ${sideWord(side)} side.`

export const ORDERS_HEADING = 'Orders'
export const NO_ORDERS = (side: AdminSide) =>
  `No orders from this customer on the ${sideWord(side)} side.`

export const EMAILS_HEADING = 'Emails'
export const EMAILS_NOTE = (side: AdminSide, shown: number) =>
  `The newest ${shown} emails queued for this customer on the ${sideWord(side)} side. The Emails page has them all, with the recipient masked.`
export const NO_EMAILS = (side: AdminSide) =>
  `No emails queued for this customer on the ${sideWord(side)} side.`
export const ALL_EMAILS = 'All of this customer’s emails'

/** A tab shows the newest rows only: past that, it says how many there are. */
export const ROWS_CAPPED = (shown: number, total: number) =>
  `Showing the newest ${shown} of ${total}.`

export const OTHER_SIDE = (side: AdminSide) =>
  `Switch to the ${side === 'test' ? 'Live' : 'Test'} side above to see that side’s records.`

// ── The account's daily allowance (SEC-11, account_domain_allowance) ──

const TIER_LABEL: Record<string, string> = {
  new: 'New account',
  standard: 'Standard',
  trusted: 'Trusted',
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "2 of 10 new domains in the last 24 hours". */
export function allowanceUsed(allowance: CustomerAllowance): string {
  return `${allowance.ordered} of ${allowance.max} new domains in the last 24 hours`
}

export function tierLabel(tier: string): string {
  return TIER_LABEL[tier] ?? tier.replace(/_/g, ' ')
}

/**
 * How the tier is decided, from the account's own settings — the same rule
 * SQL applies: standard after some days or a first paid order, trusted after
 * more days and paid orders; a test order always gets the trusted limit.
 */
export function allowanceRule(allowance: CustomerAllowance, side: AdminSide): string {
  if (side === 'test') return 'Test orders always get the trusted limit.'
  return `Standard after ${plural(allowance.standard_after_days, 'day')} or a first paid order; trusted after ${plural(allowance.trusted_after_days, 'day')} and ${plural(allowance.trusted_after_paid_orders, 'paid order')}. This account: ${plural(allowance.account_days, 'day')} old, ${plural(allowance.paid_orders, 'paid order')}.`
}
