/**
 * How an order reads while its domains are registered (PRD §13.4 steps 7–8,
 * FR-R2). The order settles line by line: a partial success is a normal
 * outcome, and each line says what happened to it.
 */

export type OrderNotice = { tone: 'success' | 'error'; text: string }

/** A new registration, or a renewal of a domain already held (FR-RN1). */
export type OrderKind = 'register' | 'renew'

const TEST_NOTE =
  'This was a test payment, so no money moved. Test orders go to the registrar’s test system, never the live registry.'

const CLOSED: OrderNotice = {
  tone: 'error',
  text: 'This order was closed without payment, so nothing was charged. If a payment for it still comes through, it is applied automatically.',
}

/** A renewal order carries one line: the domain, and the years added to it. */
export function orderKind(items: { item_type: string }[]): OrderKind {
  return items.some((item) => item.item_type === 'renew') ? 'renew' : 'register'
}

/** Still moving: the page refreshes itself until the order settles. */
export function isSettling(status: string): boolean {
  return status === 'paid' || status === 'provisioning'
}

export function orderNotice(
  status: string,
  testMode: boolean,
  kind: OrderKind = 'register',
): OrderNotice | null {
  if (kind === 'renew') return renewalNotice(status, testMode)
  const test = testMode ? ` ${TEST_NOTE}` : ''
  switch (status) {
    case 'paid':
      return {
        tone: 'success',
        text: `Your order is paid and queued for registration. This page updates as each domain completes.${test}`,
      }
    case 'provisioning':
      return {
        tone: 'success',
        text: `Registering your domains. This page updates as each one completes.${test}`,
      }
    case 'completed':
      return { tone: 'success', text: `Every domain in this order is registered.${test}` }
    case 'partially_failed':
      return {
        tone: 'error',
        text: `Some domains could not be registered — each one says why below. ${
          testMode
            ? 'No money moved.'
            : 'What you paid for those is refunded automatically — see Refunds below.'
        }`,
      }
    case 'failed':
      return {
        tone: 'error',
        text: `We could not register the domains in this order — each one says why below. ${
          testMode
            ? 'No money moved.'
            : 'What you paid is refunded automatically — see Refunds below.'
        }`,
      }
    case 'cancelled':
      // Closed on Flutterwave's page, or unpaid for 24 hours (migration 21).
      return CLOSED
    default:
      return null
  }
}

/**
 * A renewal settles when the registry shows the new expiry, not when the
 * supplier says yes (I2) — so "renewed" is only said once it has been read back.
 */
function renewalNotice(status: string, testMode: boolean): OrderNotice | null {
  const test = testMode
    ? ' This was a test payment, so no money moved. Test renewals go to the registrar’s test system, never the live registry.'
    : ''
  switch (status) {
    case 'paid':
      return {
        tone: 'success',
        text: `Your renewal is paid and queued. This page updates when the registry shows the new expiry date.${test}`,
      }
    case 'provisioning':
      return {
        tone: 'success',
        text: `Renewing your domain. This page updates when the registry shows the new expiry date.${test}`,
      }
    case 'completed':
      return { tone: 'success', text: `Your domain is renewed.${test}` }
    case 'failed':
    case 'partially_failed':
      return {
        tone: 'error',
        text: `We could not renew this domain — it says why below. ${
          testMode
            ? 'No money moved.'
            : 'What you paid is refunded automatically — see Refunds below.'
        }`,
      }
    case 'cancelled':
      return CLOSED
    default:
      return null
  }
}

export const LINE_STATUS: Record<string, string> = {
  pending: 'Queued',
  provisioning: 'Registering',
  completed: 'Registered',
  failed: 'Failed',
  refunded: 'Refunded',
}

const RENEWAL_LINE_STATUS: Record<string, string> = {
  ...LINE_STATUS,
  provisioning: 'Renewing',
  completed: 'Renewed',
}

export function lineStatus(itemType: string, status: string): string {
  return (itemType === 'renew' ? RENEWAL_LINE_STATUS : LINE_STATUS)[status] ?? status
}

/**
 * What the return from Flutterwave says (`?payment=`), before the order's own
 * progress. Where to try again depends on what was being bought.
 */
export function paymentNotice(
  payment: string,
  kind: OrderKind,
  email: string,
): OrderNotice | undefined {
  const retry =
    kind === 'renew'
      ? 'You can try again from the domain’s Renew tab.'
      : 'Your domains are still in your cart.'
  switch (payment) {
    case 'paid':
      return { tone: 'success', text: 'Payment received — thank you.' }
    case 'cancelled':
      return { tone: 'error', text: `Payment cancelled. Nothing was charged. ${retry}` }
    case 'failed':
      return {
        tone: 'error',
        text: `The payment did not go through. Nothing was charged. ${
          kind === 'renew' ? retry : 'You can try again from your cart.'
        }`,
      }
    case 'pending':
      return {
        tone: 'error',
        text: "We're still waiting for Flutterwave to confirm this payment. This page updates when it does — nothing is charged twice.",
      }
    case 'underpaid':
      return {
        tone: 'error',
        text: `We received less than this order’s total, so it hasn’t been applied and nothing has been ${
          kind === 'renew' ? 'renewed' : 'registered'
        }. The full amount is being refunded to the card or account you paid with — nothing is needed from you.`,
      }
    case 'mismatch':
      return {
        tone: 'error',
        text: `That payment doesn't match this order, so it hasn't been applied. We've recorded it to look into. If you were charged, email ${email} with your order number.`,
      }
    default:
      return undefined
  }
}
