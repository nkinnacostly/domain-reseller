import { describe, expect, it } from 'vitest'
import {
  assessTransaction,
  isTestSecretKey,
  nairaToKobo,
  ORDER_TX_REF_PREFIX,
  transactionRecord,
} from './index'

describe('assessTransaction (SEC-7)', () => {
  const order = { txRef: 'MDH-1', totalKobo: 1_978_000 }
  const tx = { tx_ref: 'MDH-1', status: 'successful', amount: 19_780, currency: 'NGN' }

  it('accepts a successful naira charge of the full amount, or more', () => {
    expect(assessTransaction(tx, order)).toBe('paid')
    expect(assessTransaction({ ...tx, amount: 20_000 }, order)).toBe('paid')
  })

  it('refuses a charge for another order before looking at anything else', () => {
    expect(assessTransaction({ ...tx, tx_ref: 'MDH-2' }, order)).toBe('wrong_order')
    expect(assessTransaction({ ...tx, tx_ref: 'MDH-2', currency: 'USD' }, order)).toBe(
      'wrong_order',
    )
  })

  it('never applies another currency, whatever the number', () => {
    expect(assessTransaction({ ...tx, currency: 'USD', amount: 1_000_000 }, order)).toBe(
      'wrong_currency',
    )
  })

  it('a charge a kobo short pays for nothing', () => {
    expect(assessTransaction({ ...tx, amount: 19_779.99 }, order)).toBe('underpaid')
  })

  it('reads pending as pending and everything else as failed', () => {
    expect(assessTransaction({ ...tx, status: 'pending' }, order)).toBe('pending')
    expect(assessTransaction({ ...tx, status: 'failed' }, order)).toBe('failed')
    expect(assessTransaction({ ...tx, status: 'cancelled' }, order)).toBe('failed')
  })
})

describe('nairaToKobo', () => {
  it('rounds away float noise', () => {
    expect(nairaToKobo(199.99)).toBe(19_999)
    expect(nairaToKobo(0.1 + 0.2)).toBe(30)
  })
})

describe('transactionRecord (N13)', () => {
  const verified = {
    id: 4_975_123,
    tx_ref: 'MDH-1',
    flw_ref: 'FLW-MOCK-1',
    amount: 19_780,
    charged_amount: 20_056.9,
    app_fee: 276.9,
    merchant_fee: 0,
    currency: 'NGN',
    status: 'successful',
    payment_type: 'card',
    created_at: '2026-09-24T10:00:00.000Z',
    ip: '102.89.1.1',
    narration: 'CARD Transaction',
    customer: { id: 1, name: 'Ada Okafor', email: 'ada@example.com', phone_number: '0803' },
    card: {
      first_6digits: '553188',
      last_4digits: '2950',
      token: 'flw-t1nf-secret-token',
      expiry: '09/32',
    },
    meta: { order_number: 'MDH-100' },
  }

  it('keeps the charge, and drops the customer, the card and its reusable token', () => {
    const record = transactionRecord(verified)
    expect(record).toEqual({
      id: 4_975_123,
      tx_ref: 'MDH-1',
      flw_ref: 'FLW-MOCK-1',
      amount: 19_780,
      charged_amount: 20_056.9,
      app_fee: 276.9,
      merchant_fee: 0,
      currency: 'NGN',
      status: 'successful',
      payment_type: 'card',
      created_at: '2026-09-24T10:00:00.000Z',
    })
    const text = JSON.stringify(record)
    for (const secret of ['ada@example.com', 'Ada Okafor', 'flw-t1nf', '553188', '102.89']) {
      expect(text).not.toContain(secret)
    }
  })

  it('refuses objects smuggled into a kept field, and caps long strings', () => {
    const record = transactionRecord({
      id: { nested: 'x' },
      flw_ref: 'F'.repeat(500),
      amount: Number.NaN,
    })
    expect(record).toEqual({ flw_ref: 'F'.repeat(200) })
  })

  it('keeps nothing from something that is not a transaction', () => {
    expect(transactionRecord(null)).toEqual({})
    expect(transactionRecord('MDH-1')).toEqual({})
  })
})

describe('keys and references', () => {
  it('tells test keys from live ones', () => {
    expect(isTestSecretKey('FLWSECK_TEST-abc-X')).toBe(true)
    expect(isTestSecretKey('FLWSECK-abc-X')).toBe(false)
  })

  it('marks our orders with one prefix', () => {
    expect(ORDER_TX_REF_PREFIX).toBe('MDH-')
  })
})
