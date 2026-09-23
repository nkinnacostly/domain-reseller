import { describe, expect, it } from 'vitest'
import { isSettling, LINE_STATUS, orderNotice } from '../lib/progress'

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
      text: 'Some domains could not be registered — each one says why below. We’ll refund what you paid for those.',
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

  it('labels every line state', () => {
    expect(Object.keys(LINE_STATUS)).toEqual([
      'pending',
      'provisioning',
      'completed',
      'failed',
      'refunded',
    ])
  })
})
