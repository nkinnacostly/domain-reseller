import { describe, expect, it } from 'vitest'
import { orderKind, orderNotice, paymentNotice } from '../lib/progress'

/** FR-P4 — a renewal of several domains is one order with a line each. */
describe('a renewal order for several domains', () => {
  it('is still a renewal order', () => {
    expect(orderKind([{ item_type: 'renew' }, { item_type: 'renew' }])).toBe('renew')
  })

  it('speaks of the domains, not the domain, while it settles', () => {
    expect(orderNotice('paid', false, 'renew', 3)?.text).toBe(
      'Your renewals are paid and queued. This page updates as the registry shows each new expiry date.',
    )
    expect(orderNotice('provisioning', false, 'renew', 3)?.text).toMatch(/^Renewing your domains\./)
    expect(orderNotice('completed', false, 'renew', 3)).toEqual({
      tone: 'success',
      text: 'Every domain in this order is renewed.',
    })
  })

  it('treats a partial success as normal, and owes a refund only for a live order', () => {
    expect(orderNotice('partially_failed', false, 'renew', 2)).toEqual({
      tone: 'error',
      text: 'Some domains could not be renewed — each one says why below. What you paid for those is refunded automatically — see Refunds below.',
    })
    expect(orderNotice('failed', false, 'renew', 2)?.text).toMatch(/refunded automatically/)
    expect(orderNotice('failed', true, 'renew', 2)?.text).toMatch(/No money moved\.$/)
    expect(orderNotice('partially_failed', true, 'renew', 2)?.text).toMatch(/No money moved\.$/)
  })

  it('tells a test order where it goes, and a closed one that nothing was charged', () => {
    expect(orderNotice('paid', true, 'renew', 2)?.text).toMatch(/never the live registry/)
    expect(orderNotice('cancelled', false, 'renew', 2)?.text).toMatch(/nothing was charged/)
    expect(orderNotice('awaiting_payment', false, 'renew', 2)).toBeNull()
  })

  it('keeps the one-domain wording for a one-line order', () => {
    expect(orderNotice('completed', false, 'renew', 1)?.text).toBe('Your domain is renewed.')
    expect(orderNotice('completed', false, 'renew')?.text).toBe('Your domain is renewed.')
  })

  it('sends a cancelled payment back to the domains list to try again', () => {
    expect(paymentNotice('cancelled', 'renew', 'hello@example.com', 2)?.text).toBe(
      'Payment cancelled. Nothing was charged. You can try again from your domains list.',
    )
    expect(paymentNotice('cancelled', 'renew', 'hello@example.com')?.text).toMatch(/Renew tab/)
  })
})
