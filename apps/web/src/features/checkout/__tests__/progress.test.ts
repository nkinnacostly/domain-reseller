import { describe, expect, it } from 'vitest'
import {
  isSettling,
  LINE_STATUS,
  lineStatus,
  orderKind,
  orderNotice,
  paymentNotice,
} from '../lib/progress'

describe('order progress (§13.4 steps 7–8)', () => {
  it('keeps refreshing only while registration is under way', () => {
    expect(isSettling('paid')).toBe(true)
    expect(isSettling('provisioning')).toBe(true)
    for (const settled of [
      'completed',
      'partially_failed',
      'failed',
      'awaiting_payment',
      'cancelled',
    ]) {
      expect(isSettling(settled)).toBe(false)
    }
  })

  it('treats a partial success as normal, and owes a refund for the rest (FR-R2)', () => {
    expect(orderNotice('partially_failed', false)).toEqual({
      tone: 'error',
      text: 'Some domains could not be registered — each one says why below. What you paid for those is refunded automatically — see Refunds below.',
    })
  })

  it('never mentions a refund for a test order', () => {
    expect(orderNotice('failed', true)?.text).not.toMatch(/refund/)
  })

  it('tells a test order where it goes', () => {
    expect(orderNotice('completed', true)?.text).toMatch(/never the live registry/)
    expect(orderNotice('completed', false)?.text).not.toMatch(/test/)
  })

  it('leaves unpaid orders to the payment notices', () => {
    expect(orderNotice('awaiting_payment', false)).toBeNull()
  })

  it('says a closed order charged nothing, and that a late payment still counts', () => {
    expect(orderNotice('cancelled', false)).toEqual({
      tone: 'error',
      text: 'This order was closed without payment, so nothing was charged. If a payment for it still comes through, it is applied automatically.',
    })
  })

  it('labels every line state', () => {
    expect(Object.keys(LINE_STATUS)).toEqual([
      'pending',
      'provisioning',
      'completed',
      'failed',
      'refunded',
    ])
  })

  it.each([
    ['paid', /paid and queued for registration/],
    ['provisioning', /Registering your domains/],
  ])('reassures while a %s order is still settling', (status, copy) => {
    const notice = orderNotice(status, false)
    expect(notice?.tone).toBe('success')
    expect(notice?.text).toMatch(copy)
    expect(notice?.text).toMatch(/This page updates/)
    expect(notice?.text).not.toMatch(/test payment/)
    expect(orderNotice(status, true)?.text).toMatch(/This was a test payment, so no money moved/)
  })

  it('promises a refund for a failed live order', () => {
    expect(orderNotice('failed', false)).toEqual({
      tone: 'error',
      text: 'We could not register the domains in this order — each one says why below. What you paid is refunded automatically — see Refunds below.',
    })
  })

  it('says no money moved for a partly failed test order', () => {
    expect(orderNotice('partially_failed', true)?.text).toMatch(/No money moved\.$/)
  })
})

describe('renewal orders (FR-RN1)', () => {
  it('knows a renewal order by its line', () => {
    expect(orderKind([{ item_type: 'renew' }])).toBe('renew')
    expect(orderKind([{ item_type: 'register' }, { item_type: 'register' }])).toBe('register')
    expect(orderKind([])).toBe('register')
  })

  it.each([
    ['paid', /renewal is paid and queued/],
    ['provisioning', /Renewing your domain/],
  ])('waits for the registry’s new expiry while a %s renewal settles (I2)', (status, copy) => {
    const notice = orderNotice(status, false, 'renew')
    expect(notice?.tone).toBe('success')
    expect(notice?.text).toMatch(copy)
    expect(notice?.text).toMatch(/registry shows the new expiry date/)
    expect(notice?.text).not.toMatch(/registration|test payment/)
    expect(orderNotice(status, true, 'renew')?.text).toMatch(
      /Test renewals go to the registrar’s test system/,
    )
  })

  it('says a renewal is done only once it is', () => {
    expect(orderNotice('completed', false, 'renew')).toEqual({
      tone: 'success',
      text: 'Your domain is renewed.',
    })
  })

  it('promises a refund for a failed live renewal, and none for a test one', () => {
    expect(orderNotice('failed', false, 'renew')).toEqual({
      tone: 'error',
      text: 'We could not renew this domain — it says why below. What you paid is refunded automatically — see Refunds below.',
    })
    expect(orderNotice('partially_failed', true, 'renew')?.text).toMatch(/No money moved\.$/)
  })

  it('reads a closed or unpaid renewal like any other order', () => {
    expect(orderNotice('cancelled', false, 'renew')).toEqual(orderNotice('cancelled', false))
    expect(orderNotice('awaiting_payment', false, 'renew')).toBeNull()
  })

  it('labels renewal lines as renewing and renewed', () => {
    expect(lineStatus('renew', 'provisioning')).toBe('Renewing')
    expect(lineStatus('renew', 'completed')).toBe('Renewed')
    expect(lineStatus('renew', 'failed')).toBe('Failed')
    expect(lineStatus('register', 'completed')).toBe('Registered')
    expect(lineStatus('register', 'something_new')).toBe('something_new')
  })
})

describe('the return from Flutterwave (?payment=)', () => {
  const EMAIL = 'hello@example.com'

  it('sends a cancelled cart order back to the cart, and a renewal back to its Renew tab', () => {
    expect(paymentNotice('cancelled', 'register', EMAIL)?.text).toBe(
      'Payment cancelled. Nothing was charged. Your domains are still in your cart.',
    )
    expect(paymentNotice('cancelled', 'renew', EMAIL)?.text).toBe(
      'Payment cancelled. Nothing was charged. You can try again from the domain’s Renew tab.',
    )
  })

  it('says where to try again after a failed payment', () => {
    expect(paymentNotice('failed', 'register', EMAIL)?.text).toMatch(/try again from your cart\.$/)
    expect(paymentNotice('failed', 'renew', EMAIL)?.text).toMatch(/Renew tab\.$/)
  })

  it('says an underpaid renewal renewed nothing', () => {
    expect(paymentNotice('underpaid', 'renew', EMAIL)?.text).toMatch(/nothing has been renewed/)
    expect(paymentNotice('underpaid', 'register', EMAIL)?.text).toMatch(
      /nothing has been registered/,
    )
  })

  it('thanks a paid order, reassures a pending one, and names the address for a mismatch', () => {
    expect(paymentNotice('paid', 'renew', EMAIL)).toEqual({
      tone: 'success',
      text: 'Payment received — thank you.',
    })
    expect(paymentNotice('pending', 'register', EMAIL)?.text).toMatch(/nothing is charged twice/)
    expect(paymentNotice('mismatch', 'register', EMAIL)?.text).toMatch(/email hello@example\.com/)
  })

  it('ignores a value it does not know', () => {
    expect(paymentNotice('forged', 'register', EMAIL)).toBeUndefined()
  })
})
