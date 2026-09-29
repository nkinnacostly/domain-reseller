import { describe, expect, it } from 'vitest'
import {
  lineLabel,
  notDoneLabel,
  paymentMethodLabel,
  type ReceiptRow,
  receiptCustomer,
  receiptDate,
  toReceipt,
} from '../lib/receipt'

const ADA = {
  firstName: 'Ada',
  lastName: 'Okafor',
  company: 'Paidly Ltd',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '12 Admiralty Way',
  addressLine2: 'Lekki Phase 1',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

const row = (overrides: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id: 'order-1',
  order_number: 'ND-001001',
  invoice_number: 'INV-000042',
  paid_at: '2026-09-24T09:15:00Z',
  payment_id: 'payment-1',
  tx_ref: 'MDH-6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10',
  subtotal_kobo: '3680000',
  vat_pct: '7.5',
  vat_kobo: '276000',
  total_kobo: '3956000',
  registrant: ADA,
  test_mode: false,
  order_items: [
    {
      id: 'b-line',
      item_type: 'register',
      domain: 'getpaid.co',
      period_years: 2,
      price_kobo: '1840000',
      renewal_kobo: '1870000',
      status: 'failed',
      created_at: '2026-09-24T09:00:00Z',
    },
    {
      id: 'a-line',
      item_type: 'register',
      domain: 'getpaid.com',
      period_years: 1,
      price_kobo: 1_840_000,
      renewal_kobo: 1_870_000,
      status: 'completed',
      created_at: '2026-09-24T09:00:00Z',
    },
  ],
  payments: [
    {
      id: 'payment-2',
      provider_reference: '9990002',
      amount_kobo: '3956000',
      method: 'card',
      created_at: '2026-09-24T09:20:00Z',
    },
    {
      id: 'payment-1',
      provider_reference: '9990001',
      amount_kobo: '3956000',
      method: 'bank_transfer',
      created_at: '2026-09-24T09:15:00Z',
    },
  ],
  ...overrides,
})

describe('toReceipt — only a paid order has one (CMP-17)', () => {
  it('has none for an order without an invoice number', () => {
    expect(toReceipt(row({ invoice_number: null }))).toBeNull()
  })

  it('has none for an order that was never paid', () => {
    expect(toReceipt(row({ paid_at: null }))).toBeNull()
  })
})

describe('toReceipt — what it shows', () => {
  it('carries the invoice number, the date paid and the order’s own totals, in kobo', () => {
    expect(toReceipt(row())).toMatchObject({
      orderId: 'order-1',
      orderNumber: 'ND-001001',
      invoiceNumber: 'INV-000042',
      paidAt: '2026-09-24T09:15:00Z',
      testMode: false,
      subtotalKobo: 3_680_000,
      vatPct: 7.5,
      vatKobo: 276_000,
      totalKobo: 3_956_000,
    })
  })

  it('lists every line in the order it was bought, with its renewal price (N8)', () => {
    expect(toReceipt(row())?.lines).toEqual([
      {
        id: 'a-line',
        domain: 'getpaid.com',
        kind: 'register',
        years: 1,
        priceKobo: 1_840_000,
        renewalKobo: 1_870_000,
        renewalYears: 1,
        failed: false,
      },
      {
        id: 'b-line',
        domain: 'getpaid.co',
        kind: 'register',
        years: 2,
        priceKobo: 1_840_000,
        renewalKobo: 1_870_000,
        renewalYears: 1,
        failed: true,
      },
    ])
  })

  it('keeps the renewal term the line recorded, and reads a line without one as a year', () => {
    const [first, second] = row().order_items
    const receipt = toReceipt(
      row({
        order_items: [
          { ...(first as ReceiptRow['order_items'][number]), renewal_years: 2 },
          { ...(second as ReceiptRow['order_items'][number]), renewal_years: null },
        ],
      }),
    )
    expect(receipt?.lines.map((line) => line.renewalYears).sort()).toEqual([1, 2])
  })

  it('tells a renewal and a transfer from a registration', () => {
    const [first, second] = row().order_items
    const receipt = toReceipt(
      row({
        order_items: [
          { ...(first as ReceiptRow['order_items'][number]), item_type: 'renew' },
          {
            ...(second as ReceiptRow['order_items'][number]),
            item_type: 'transfer',
            created_at: '2026-09-24T09:01:00Z',
          },
        ],
      }),
    )
    expect(receipt?.lines.map((line) => line.kind)).toEqual(['renew', 'transfer'])
  })

  it('receipts the charge that paid the order, not a second one that is refunded', () => {
    expect(toReceipt(row())?.payment).toEqual({
      reference: 'MDH-6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10',
      transactionId: '9990001',
      method: 'Bank transfer, through Flutterwave',
      amountKobo: 3_956_000,
    })
  })

  it('falls back to the first charge for an order paid before the charge was linked', () => {
    expect(toReceipt(row({ payment_id: null }))?.payment.transactionId).toBe('9990001')
  })

  it('still shows our reference when no charge can be read', () => {
    expect(toReceipt(row({ payment_id: null, payments: [] }))?.payment).toEqual({
      reference: 'MDH-6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10',
      transactionId: null,
      method: 'Flutterwave',
      amountKobo: null,
    })
  })

  it('names the customer from the registrant recorded on the order', () => {
    expect(toReceipt(row(), (code) => (code === 'NG' ? 'Nigeria' : code))?.customer).toEqual({
      name: 'Ada Okafor',
      company: 'Paidly Ltd',
      email: 'ada@example.com',
      address: ['12 Admiralty Way', 'Lekki Phase 1', 'Lagos, Lagos, 100001', 'Nigeria'],
    })
  })
})

describe('receiptCustomer — never a guess', () => {
  it('shows nothing it does not have, for a renewal of a domain with no registrant', () => {
    expect(receiptCustomer({})).toEqual({ name: null, company: null, email: null, address: [] })
    expect(receiptCustomer(null)).toEqual({ name: null, company: null, email: null, address: [] })
  })

  it('leaves out blank and non-text parts', () => {
    expect(
      receiptCustomer({ firstName: 'Ada', lastName: '  ', company: '', city: 7, country: 'GH' }),
    ).toEqual({ name: 'Ada', company: null, email: null, address: ['GH'] })
  })
})

describe('receipt wording', () => {
  it.each([
    ['register', 1, 'Registration, 1 year'],
    ['renew', 2, 'Renewal, 2 years'],
    ['transfer', 1, 'Transfer, 1 year'],
  ] as const)('reads a %s line of %i year(s) as “%s”', (kind, years, label) => {
    expect(lineLabel(kind, years)).toBe(label)
  })

  it.each([
    ['register', 'Not registered'],
    ['renew', 'Not renewed'],
    ['transfer', 'Not transferred'],
  ] as const)('says a failed %s line was “%s” (FR-R2)', (kind, label) => {
    expect(notDoneLabel(kind)).toBe(label)
  })

  it.each([
    ['card', 'Card, through Flutterwave'],
    ['BANK_TRANSFER', 'Bank transfer, through Flutterwave'],
    ['banktransfer', 'Bank transfer, through Flutterwave'],
    ['account', 'Bank account, through Flutterwave'],
    ['ussd', 'USSD, through Flutterwave'],
    ['mobilemoneygh', 'Flutterwave'],
    ['', 'Flutterwave'],
    [null, 'Flutterwave'],
  ])('describes the payment method %j as “%s”', (method, label) => {
    expect(paymentMethodLabel(method)).toBe(label)
  })

  it('dates a payment in Lagos: 23:30 UTC is already the next day there', () => {
    expect(receiptDate('2026-09-23T23:30:00.000Z')).toBe('24 September 2026')
  })
})
