import type { AdminSide } from '@/features/admin/lib/side'
import type { Tone } from '@/features/admin/lib/tone'

/**
 * The orders pages' words (docs/ADMIN-SPEC.md §5.2, B2), in one place so
 * tests hold them exactly. They say what happened and what to do next; none
 * describes a mechanism the dashboard does not have (N9b).
 */

export const sideWord = (side: AdminSide) => (side === 'test' ? 'Test' : 'Live')

export const ORDERS_DESCRIPTION =
  'Every order on this side: what it bought, its payment, invoice and float check. Open one for its costs, payments, refunds and supplier calls.'

export const SEARCH_HINT =
  'An order number (ND-…), payment reference (MDH-…), invoice (INV-…) or domain. Find a customer by email on the Customers page.'

/** The browser's own message when an email is typed into the box: the form is never sent. */
export const SEARCH_NOT_EMAIL =
  'Orders are not searched by email. Find the customer on the Customers page.'

export const EMAIL_REFUSED =
  'Nothing was searched: orders are never looked up by email, because an email in a link stays in browser history and logs. Find the customer on the Customers page, then open their orders there.'

export const UNKNOWN_SEARCH =
  'Nothing was searched: that isn’t an order number (ND-…), a payment reference (MDH-…), an invoice number (INV-…) or a domain.'

export const CAPPED_NOTICE =
  'This filter matched more orders than one read takes, so only the newest are listed. Narrow the dates to see older ones.'

export const STUCK_NOTE: Record<'no_threshold', string> = {
  no_threshold:
    'The stuck-order threshold couldn’t be read, so this lists every paid order still settling.',
}

export const STUCK_HINT = 'Paid, and still settling past the stuck-order threshold.'

export const NO_ORDERS = (side: AdminSide) => `No orders on the ${sideWord(side)} side yet.`
export const NO_MATCH = 'No orders match these filters.'
export const LIST_ERROR = 'The orders couldn’t be loaded.'
export const FUNNEL_ERROR = 'The funnel couldn’t be read.'

export const ORDER_NOT_FOUND = (side: AdminSide) =>
  `No order with this id on the ${sideWord(side)} side.`
export const ORDER_NOT_FOUND_BODY =
  'It may be on the other side, or the link may be wrong. Switch sides above, or find it in the list.'
export const ORDER_ERROR = 'This order couldn’t be loaded.'
export const SECTION_ERROR = 'This part of the order couldn’t be loaded.'

export const NO_LINES = 'This order has no lines.'
export const NO_PAYMENTS = 'No payment is recorded for this order.'
export const NO_REFUNDS = 'No refunds for this order.'
export const NO_INCIDENTS = 'No payment incidents for this order.'
export const NO_JOBS = 'No registry jobs for this order’s lines yet.'
export const NO_CALLS = 'No supplier calls are recorded for this order’s jobs.'
export const NO_ACTIVITY = 'No domain activity since this order was placed.'
export const SSL_TRACE_NOTE =
  'A certificate’s jobs and supplier calls are on its page under SSL, not here.'

/** A supplier call's outcome in words, and how it looks (migration 13's five). */
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

export const INCIDENT_STATE_LABEL: Record<string, string> = {
  open: 'Open',
  resolved: 'Resolved',
}

/** A charge's status as Flutterwave gave it; an unknown one shows as itself. */
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  successful: 'Successful',
  failed: 'Failed',
  pending: 'Pending',
}

export function paymentTone(status: string | null | undefined): Tone {
  if (status === 'successful') return 'ok'
  if (status === 'failed') return 'danger'
  return 'neutral'
}
