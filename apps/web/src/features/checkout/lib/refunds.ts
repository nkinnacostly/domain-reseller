/**
 * How a refund reads to the customer (PRD FR-R3, §8.5). Plain states only —
 * a refund held for a person, or waiting on our balance, is still "being
 * processed" from where they stand, and nothing is asked of them.
 */

const REASONS: Record<string, string> = {
  duplicate_charge: 'A second charge for this order',
  overpayment: 'The amount paid over the total',
  underpayment: 'A payment below the order total',
  empty_order: 'A payment for an order with nothing in it',
}

export function refundLabel(refund: { reason: string; domain: string | null }): string {
  if (refund.reason === 'registration_failed' && refund.domain) return refund.domain
  return REASONS[refund.reason] ?? 'Refund'
}

export const REFUND_STATE: Record<string, string> = {
  processing: 'Being processed',
  sent: 'On its way',
  refunded: 'Refunded',
}

/** A sentence for the refund's state; `testMode` refunds move no money. */
export function refundDetail(
  refund: { state: string; refundedAt: string | null; testMode: boolean },
  format: (iso: string) => string,
): string {
  if (refund.testMode) return 'Test refund — no money moves.'
  switch (refund.state) {
    case 'refunded':
      return refund.refundedAt
        ? `Returned on ${format(refund.refundedAt)} to the card or account you paid with.`
        : 'Returned to the card or account you paid with.'
    case 'sent':
      return 'Flutterwave has sent it back to the card or account you paid with. Card refunds can take up to 15 business days to show; bank refunds are usually quicker.'
    default:
      return 'We send it back to the card or account you paid with automatically. Nothing is needed from you.'
  }
}
