/**
 * How an order reads while its domains are registered (PRD §13.4 steps 7–8,
 * FR-R2). The order settles line by line: a partial success is a normal
 * outcome, and each line says what happened to it.
 */

export type OrderNotice = { tone: 'success' | 'error'; text: string }

/** A new registration, a renewal of a domain already held (FR-RN1), or a transfer in (E9). */
export type OrderKind = 'register' | 'renew' | 'transfer'

const TEST_NOTE =
  'This was a test payment, so no money moved. Test orders go to the registrar’s test system, never the live registry.'

const CLOSED: OrderNotice = {
  tone: 'error',
  text: 'This order was closed without payment, so nothing was charged. If a payment for it still comes through, it is applied automatically.',
}

/**
 * A transfer order carries one line; a renewal order one line per domain
 * renewed — one from a domain's Renew tab, several from the portfolio
 * (FR-P4). Neither is ever mixed with registrations.
 */
export function orderKind(items: { item_type: string }[]): OrderKind {
  if (items.some((item) => item.item_type === 'renew')) return 'renew'
  if (items.some((item) => item.item_type === 'transfer')) return 'transfer'
  return 'register'
}

/** Still moving: the page refreshes itself until the order settles. */
export function isSettling(status: string): boolean {
  return status === 'paid' || status === 'provisioning'
}

export function orderNotice(
  status: string,
  testMode: boolean,
  kind: OrderKind = 'register',
  /** How many lines the order has — a renewal of several domains says so. */
  lines = 1,
): OrderNotice | null {
  if (kind === 'renew')
    return lines > 1 ? bulkRenewalNotice(status, testMode) : renewalNotice(status, testMode)
  if (kind === 'transfer') return transferNotice(status, testMode)
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

/** Several domains renewed in one order (FR-P4): each line settles on its own. */
function bulkRenewalNotice(status: string, testMode: boolean): OrderNotice | null {
  const test = testMode
    ? ' This was a test payment, so no money moved. Test renewals go to the registrar’s test system, never the live registry.'
    : ''
  switch (status) {
    case 'paid':
      return {
        tone: 'success',
        text: `Your renewals are paid and queued. This page updates as the registry shows each new expiry date.${test}`,
      }
    case 'provisioning':
      return {
        tone: 'success',
        text: `Renewing your domains. This page updates as the registry shows each new expiry date.${test}`,
      }
    case 'completed':
      return { tone: 'success', text: `Every domain in this order is renewed.${test}` }
    case 'partially_failed':
      return {
        tone: 'error',
        text: `Some domains could not be renewed — each one says why below. ${
          testMode
            ? 'No money moved.'
            : 'What you paid for those is refunded automatically — see Refunds below.'
        }`,
      }
    case 'failed':
      return {
        tone: 'error',
        text: `We could not renew the domains in this order — each one says why below. ${
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

/**
 * A transfer is done when the domain is active in our account, which can take
 * days: the current registrar may ask the owner to approve, and the registry
 * completes it after five days if they don't answer (FR-T3). Copy says so,
 * and says nothing is done before it is.
 */
function transferNotice(status: string, testMode: boolean): OrderNotice | null {
  const test = testMode
    ? ' This was a test payment, so no money moved. Test transfers go to the registrar’s test system, never the live registry.'
    : ''
  switch (status) {
    case 'paid':
      return {
        tone: 'success',
        text: `Your transfer is paid and queued. We send the request to the registry next, and this page updates as it moves.${test}`,
      }
    case 'provisioning':
      return {
        tone: 'success',
        text: `Transferring your domain. Your current registrar may email the domain’s owner to approve it; if they don’t answer, the registry completes it after five days. Transfers usually take up to five days, and this page updates when it lands.${test}`,
      }
    case 'completed':
      return { tone: 'success', text: `Your domain has transferred in.${test}` }
    case 'failed':
    case 'partially_failed':
      return {
        tone: 'error',
        text: `We could not transfer this domain — it says why below. ${
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

const TRANSFER_LINE_STATUS: Record<string, string> = {
  ...LINE_STATUS,
  provisioning: 'Transferring',
  completed: 'Transferred',
}

export function lineStatus(itemType: string, status: string): string {
  const labels =
    itemType === 'renew'
      ? RENEWAL_LINE_STATUS
      : itemType === 'transfer'
        ? TRANSFER_LINE_STATUS
        : LINE_STATUS
  return labels[status] ?? status
}

/**
 * What the return from Flutterwave says (`?payment=`), before the order's own
 * progress. Where to try again depends on what was being bought.
 */
export function paymentNotice(
  payment: string,
  kind: OrderKind,
  email: string,
  lines = 1,
): OrderNotice | undefined {
  const retry =
    kind === 'renew'
      ? lines > 1
        ? 'You can try again from your domains list.'
        : 'You can try again from the domain’s Renew tab.'
      : kind === 'transfer'
        ? 'You can start the transfer again from the transfer page.'
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
          kind === 'register' ? 'You can try again from your cart.' : retry
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
          kind === 'renew' ? 'renewed' : kind === 'transfer' ? 'transferred' : 'registered'
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
