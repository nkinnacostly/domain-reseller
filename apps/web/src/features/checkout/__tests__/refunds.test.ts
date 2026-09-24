import { describe, expect, it } from 'vitest'
import { REFUND_STATE, refundDetail, refundLabel } from '../lib/refunds'

describe('refund copy (FR-R3)', () => {
  const format = () => '24 Sept 2026'

  it('names the domain for a failed line, and the reason otherwise', () => {
    expect(refundLabel({ reason: 'registration_failed', domain: 'getpaid.com' })).toBe(
      'getpaid.com',
    )
    expect(refundLabel({ reason: 'duplicate_charge', domain: null })).toBe(
      'A second charge for this order',
    )
    expect(refundLabel({ reason: 'underpayment', domain: null })).toMatch(/below the order total/)
    expect(refundLabel({ reason: 'something_new', domain: null })).toBe('Refund')
  })

  it('says where the money goes and that nothing is needed', () => {
    expect(
      refundDetail({ state: 'processing', refundedAt: null, testMode: false }, format),
    ).toMatch(/card or account you paid with automatically\. Nothing is needed from you/)
  })

  it('is honest about how long a card refund can take to show', () => {
    expect(refundDetail({ state: 'sent', refundedAt: null, testMode: false }, format)).toMatch(
      /up to 15 business days/,
    )
  })

  it('dates a completed refund', () => {
    expect(
      refundDetail(
        { state: 'refunded', refundedAt: '2026-09-24T10:00:00Z', testMode: false },
        format,
      ),
    ).toBe('Returned on 24 Sept 2026 to the card or account you paid with.')
  })

  it('says a test refund moves no money', () => {
    expect(refundDetail({ state: 'refunded', refundedAt: null, testMode: true }, format)).toBe(
      'Test refund — no money moves.',
    )
  })

  it('has a label for every state the customer can see', () => {
    expect(Object.keys(REFUND_STATE).sort()).toEqual(['processing', 'refunded', 'sent'])
  })
})
