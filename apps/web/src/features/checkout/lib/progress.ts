/**
 * How an order reads while its domains are registered (PRD §13.4 steps 7–8,
 * FR-R2). The order settles line by line: a partial success is a normal
 * outcome, and each line says what happened to it.
 */

export type OrderNotice = { tone: 'success' | 'error'; text: string }

const TEST_NOTE =
  'This was a test payment, so no money moved. Test orders go to the registrar’s test system, never the live registry.'

/** Still moving: the page refreshes itself until the order settles. */
export function isSettling(status: string): boolean {
  return status === 'paid' || status === 'provisioning'
}

export function orderNotice(status: string, testMode: boolean): OrderNotice | null {
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
          testMode ? 'No money moved.' : 'We’ll refund what you paid for those.'
        }`,
      }
    case 'failed':
      return {
        tone: 'error',
        text: `We could not register the domains in this order — each one says why below. ${
          testMode ? 'No money moved.' : 'We’ll refund what you paid.'
        }`,
      }
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
