import { describe, expect, it } from 'vitest'
import {
  CALL_OUTCOME_LABEL,
  callOutcomeTone,
  EMAIL_REFUSED,
  NO_ORDERS,
  ORDER_NOT_FOUND,
  SEARCH_HINT,
  STUCK_NOTE,
  sideWord,
} from '@/features/admin/lib/orders-copy'
import {
  absorbedText,
  durationText,
  lineCostText,
  lineRenewalText,
  lineTermText,
  nairaOrUnreported,
  orderKindsText,
  sentenceCase,
  waitText,
} from '@/features/admin/lib/orders-format'

describe('an order in words', () => {
  it('names the kinds its lines buy, in a fixed order', () => {
    expect(orderKindsText([{ item_type: 'register' }])).toBe('Registration')
    expect(
      orderKindsText([{ item_type: 'ssl' }, { item_type: 'register' }, { item_type: 'register' }]),
    ).toBe('Registration, Certificate')
    expect(orderKindsText([{ item_type: 'renew' }, { item_type: 'transfer' }])).toBe(
      'Renewal, Transfer in',
    )
    expect(orderKindsText([{ item_type: 'gift_card' }])).toBe('gift card')
    expect(orderKindsText([])).toBe('No lines')
  })

  it('gives each line its term', () => {
    expect(lineTermText({ item_type: 'register', period_years: 1 })).toBe('1 year')
    expect(lineTermText({ item_type: 'renew', period_years: 2 })).toBe('2 years')
    expect(lineTermText({ item_type: 'ssl', period_years: 1 })).toBe('1-year subscription')
  })

  it('never shows a price without its renewal (N8)', () => {
    expect(
      lineRenewalText({ item_type: 'register', renewal_kobo: 1_870_000, renewal_years: 1 }),
    ).toBe('Renews at ₦18,700/yr')
    // A block-sold extension renews at the whole block's price.
    expect(
      lineRenewalText({ item_type: 'register', renewal_kobo: 19_980_000, renewal_years: 2 }),
    ).toBe('Renews at ₦399,600 every 2 years')
    // A line from before migration 37 renews yearly.
    expect(
      lineRenewalText({ item_type: 'transfer', renewal_kobo: 1_870_000, renewal_years: null }),
    ).toBe('Renews at ₦18,700/yr')
    // A certificate never renews by itself: a new one is bought.
    expect(lineRenewalText({ item_type: 'ssl', renewal_kobo: 2_500_000, renewal_years: 1 })).toBe(
      'A new one is ₦25,000 at today’s price',
    )
  })

  it('shows a cost only as checkout recorded it, in cents (D13, D24)', () => {
    expect(lineCostText({ supplier_cost_cents: 1131, icann_fee_cents: 20 })).toBe(
      '$11.31 + $0.20 ICANN (recorded at checkout)',
    )
    expect(lineCostText({ supplier_cost_cents: 5000, icann_fee_cents: 0 })).toBe(
      '$50.00 (recorded at checkout)',
    )
    expect(lineCostText(null)).toBe('Not recorded')
    expect(lineCostText(undefined)).toBe('Not recorded')
  })

  it('says when Flutterwave did not report an amount, and who paid its fee', () => {
    expect(nairaOrUnreported(15_000)).toBe('₦150')
    expect(nairaOrUnreported(0)).toBe('₦0')
    expect(nairaOrUnreported(null)).toBe('Not reported')
    expect(absorbedText(true)).toBe('We paid it')
    expect(absorbedText(false)).toBe('The customer paid it')
    expect(absorbedText(null)).toBe('Not reported')
  })

  it('writes durations and waits plainly', () => {
    expect(durationText(820)).toBe('820 ms')
    expect(durationText(2400)).toBe('2.4 s')
    expect(durationText(null)).toBe('—')
    expect(waitText(45)).toBe('45 s')
    expect(waitText(720)).toBe('12 min')
    expect(waitText(3600)).toBe('1 h')
    expect(waitText(3 * 3600 + 300)).toBe('3 h 5 min')
    expect(waitText(86_400)).toBe('1 day')
    expect(waitText(2 * 86_400 + 4 * 3600)).toBe('2 days 4 h')
    expect(waitText(null)).toBe('—')
    expect(waitText(-1)).toBe('—')
  })

  it('turns codes into sentences', () => {
    expect(sentenceCase('nameservers_requested')).toBe('Nameservers requested')
    expect(sentenceCase('card')).toBe('Card')
    expect(sentenceCase(null)).toBe('—')
  })
})

describe('the orders pages’ words', () => {
  it('names the side', () => {
    expect(sideWord('test')).toBe('Test')
    expect(NO_ORDERS('live')).toBe('No orders on the Live side yet.')
    expect(ORDER_NOT_FOUND('test')).toBe('No order with this id on the Test side.')
  })

  it('sends email searches to Customers, and never promises one here', () => {
    expect(EMAIL_REFUSED).toContain('never looked up by email')
    expect(EMAIL_REFUSED).toContain('Customers page')
    expect(SEARCH_HINT).toContain('Find a customer by email on the Customers page')
  })

  it('says why the stuck filter lists every settling order', () => {
    expect(STUCK_NOTE.test_admin).toBe(
      'Test administrators can’t read the stuck-order threshold, so this lists every paid order still settling.',
    )
    expect(STUCK_NOTE.no_threshold).toContain('couldn’t be read')
  })

  it('words every supplier call outcome, and colours none alone', () => {
    for (const outcome of ['ok', 'not_found', 'rejected', 'blocked', 'unknown']) {
      expect(CALL_OUTCOME_LABEL[outcome]).toBeTruthy()
    }
    expect(callOutcomeTone('ok')).toBe('ok')
    expect(callOutcomeTone('not_found')).toBe('info')
    expect(callOutcomeTone('unknown')).toBe('warning')
    expect(callOutcomeTone('rejected')).toBe('danger')
    expect(callOutcomeTone('blocked')).toBe('danger')
    expect(callOutcomeTone('something_new')).toBe('neutral')
  })
})
