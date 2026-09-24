import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Flutterwave, FlutterwaveCharge, FlutterwaveResult } from './flutterwave'
import type { DueOrder, PaymentStore } from './store'
import { createPaymentSweeper } from './sweeper'

/**
 * The sweeper finds a paid order whose redirect and webhook both went
 * missing. What matters: it records exactly what Flutterwave confirms, by
 * the same rules as the web app, and never records anything it should not.
 */

const TX_REF = 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69'
const ORDER: DueOrder = { id: 'order-1', txRef: TX_REF, totalKobo: 1_978_000, orderNumber: 'ND-1' }

const charge = (overrides: Partial<FlutterwaveCharge> = {}): FlutterwaveCharge => ({
  id: '4242',
  txRef: TX_REF,
  flwRef: 'FLW-1',
  status: 'successful',
  currency: 'NGN',
  amountKobo: 1_978_000,
  raw: {
    id: 4242,
    tx_ref: TX_REF,
    flw_ref: 'FLW-1',
    amount: 19_780,
    currency: 'NGN',
    status: 'successful',
    payment_type: 'card',
    customer: { email: 'ada@example.com', name: 'Ada Okafor' },
    card: { token: 'flw-t1nf-secret', last_4digits: '2950' },
  },
  ...overrides,
})

const ok = <T>(data: T): FlutterwaveResult<T> => ({ kind: 'ok', data })

function setup(found: FlutterwaveResult<FlutterwaveCharge | null>, due: DueOrder[] = [ORDER]) {
  const store = {
    ordersToCheck: vi.fn(async () => due),
    recordPayment: vi.fn(async () => {}),
    recordUnderpayment: vi.fn(async () => {}),
    recordIncident: vi.fn(async () => {}),
  } satisfies PaymentStore
  const refuse = async (): Promise<never> => {
    throw new Error('the sweeper never moves money')
  }
  const flutterwave = {
    createRefund: vi.fn(refuse),
    listRefunds: vi.fn(refuse),
    getRefund: vi.fn(refuse),
    chargebackCount: vi.fn(refuse),
    availableBalanceKobo: vi.fn(refuse),
    verifyTransaction: vi.fn(refuse),
    verifyByReference: vi.fn(async () => found),
  } satisfies Flutterwave
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const sweeper = createPaymentSweeper({
    store,
    flutterwave,
    testMode: true,
    everyMs: 60_000,
    log,
  })
  return { sweeper, store, flutterwave, log }
}

beforeEach(() => vi.clearAllMocks())

describe('the payment sweeper', () => {
  it('asks Flutterwave by the order’s own reference, for this side only', async () => {
    const { sweeper, store, flutterwave } = setup(ok(null))
    expect(await sweeper.sweep()).toEqual({ unpaid: 1 })
    expect(store.ordersToCheck).toHaveBeenCalledWith(true, 20)
    expect(flutterwave.verifyByReference).toHaveBeenCalledWith(TX_REF)
    expect(store.recordPayment).not.toHaveBeenCalled()
  })

  it('records a payment nothing else caught, keeping no customer or card detail', async () => {
    const { sweeper, store, log } = setup(ok(charge()))
    expect(await sweeper.sweep()).toEqual({ paid: 1 })
    expect(store.recordPayment).toHaveBeenCalledWith({
      orderId: 'order-1',
      providerReference: '4242',
      amountKobo: 1_978_000,
      currency: 'NGN',
      method: 'card',
      raw: {
        id: 4242,
        tx_ref: TX_REF,
        flw_ref: 'FLW-1',
        amount: 19_780,
        currency: 'NGN',
        status: 'successful',
        payment_type: 'card',
      },
    })
    // Worth a person's look: the webhook missed it.
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/sweeper/))
  })

  it('refunds a short payment instead of applying it', async () => {
    const { sweeper, store } = setup(ok(charge({ amountKobo: 500_000 })))
    expect(await sweeper.sweep()).toEqual({ underpaid: 1 })
    expect(store.recordUnderpayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountKobo: 500_000 }),
    )
    expect(store.recordPayment).not.toHaveBeenCalled()
  })

  it('never applies another currency — a person looks', async () => {
    const { sweeper, store } = setup(ok(charge({ currency: 'USD' })))
    expect(await sweeper.sweep()).toEqual({ wrong_currency: 1 })
    expect(store.recordPayment).not.toHaveBeenCalled()
    expect(store.recordIncident).toHaveBeenCalledWith('currency_mismatch', 'order-1', '4242', {
      status: 'successful',
      currency: 'USD',
      amount_kobo: 1_978_000,
    })
  })

  it('never applies a charge for another reference', async () => {
    const { sweeper, store } = setup(ok(charge({ txRef: 'MDH-other' })))
    expect(await sweeper.sweep()).toEqual({ wrong_order: 1 })
    expect(store.recordPayment).not.toHaveBeenCalled()
    expect(store.recordIncident).toHaveBeenCalledWith(
      'tx_ref_mismatch',
      'order-1',
      '4242',
      expect.anything(),
    )
  })

  it.each(['pending', 'failed'])('leaves a %s charge alone', async (status) => {
    const { sweeper, store } = setup(ok(charge({ status })))
    await sweeper.sweep()
    expect(store.recordPayment).not.toHaveBeenCalled()
    expect(store.recordIncident).not.toHaveBeenCalled()
  })

  it('records an incident when a confirmed payment cannot be recorded', async () => {
    const { sweeper, store } = setup(ok(charge()))
    store.recordPayment.mockRejectedValueOnce(new Error('db down'))
    expect(await sweeper.sweep()).toEqual({ unrecorded: 1 })
    expect(store.recordIncident).toHaveBeenCalledWith(
      'unrecorded_payment',
      'order-1',
      '4242',
      expect.anything(),
    )
  })

  it('moves on when Flutterwave cannot be asked; the order is due again later', async () => {
    const { sweeper, store } = setup(
      { kind: 'unknown', code: 'FLW_NO_ANSWER', message: 'timeout' },
      [ORDER, { ...ORDER, id: 'order-2' }],
    )
    expect(await sweeper.sweep()).toEqual({ unknown: 2 })
    expect(store.recordPayment).not.toHaveBeenCalled()
  })

  it('keeps going past an order that crashes', async () => {
    const { sweeper, flutterwave, log } = setup(ok(null), [ORDER, { ...ORDER, id: 'order-2' }])
    flutterwave.verifyByReference.mockRejectedValueOnce(new Error('boom'))
    expect(await sweeper.sweep()).toEqual({ error: 1, unpaid: 1 })
    expect(log.error).toHaveBeenCalled()
  })

  it('never calls anything that moves money', async () => {
    const { sweeper, flutterwave } = setup(ok(charge()))
    await sweeper.sweep()
    expect(flutterwave.createRefund).not.toHaveBeenCalled()
  })

  it('starts once, and stops after the sweep in hand', async () => {
    const { sweeper, store } = setup(ok(null))
    sweeper.start()
    sweeper.start()
    await sweeper.stop()
    expect(store.ordersToCheck).toHaveBeenCalledTimes(1)
  })
})
