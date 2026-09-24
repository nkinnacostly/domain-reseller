import { describe, expect, it, vi } from 'vitest'
import { checkPayment, type PaymentFacts } from './charge-check'
import type { Flutterwave, FlutterwaveCharge, FlutterwaveResult } from './flutterwave'

const TX_REF = 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69'

const FACTS: PaymentFacts = {
  orderTxRef: TX_REF,
  orderTotalKobo: 1_978_000,
  reference: '4242',
  amountKobo: 1_978_000,
  currency: 'NGN',
  status: 'successful',
}

const charge = (overrides: Partial<FlutterwaveCharge> = {}): FlutterwaveCharge => ({
  id: '4242',
  txRef: TX_REF,
  flwRef: 'FLW-1',
  status: 'successful',
  currency: 'NGN',
  amountKobo: 1_978_000,
  raw: {},
  ...overrides,
})

function flutterwave(answer: FlutterwaveResult<FlutterwaveCharge>) {
  const refuse = async (): Promise<never> => {
    throw new Error('only the charge is read')
  }
  return {
    createRefund: vi.fn(refuse),
    listRefunds: vi.fn(refuse),
    getRefund: vi.fn(refuse),
    chargebackCount: vi.fn(refuse),
    availableBalanceKobo: vi.fn(refuse),
    listCharges: vi.fn(refuse),
    verifyTransaction: vi.fn(async () => answer),
  } satisfies Flutterwave
}

const ok = (data: FlutterwaveCharge): FlutterwaveResult<FlutterwaveCharge> => ({ kind: 'ok', data })

describe('checkPayment (SEC-7)', () => {
  it('confirms a real, full naira charge for this order', async () => {
    const fw = flutterwave(ok(charge()))
    expect(await checkPayment(fw, FACTS)).toEqual({ kind: 'verified' })
    expect(fw.verifyTransaction).toHaveBeenCalledWith('4242')
  })

  it('confirms an overpaid order: the excess is refunded separately', async () => {
    const fw = flutterwave(ok(charge({ amountKobo: 2_000_000 })))
    expect(await checkPayment(fw, { ...FACTS, amountKobo: 2_000_000 })).toEqual({
      kind: 'verified',
    })
  })

  it.each([
    ['no recorded payment', { reference: null }],
    ['a reference that is not ours', { orderTxRef: 'PAIDLY-1' }],
    ['a payment recorded as short', { status: 'underpaid' }],
    ['a payment in another currency', { currency: 'USD' }],
    ['a payment below the total', { amountKobo: 1_977_999 }],
  ] as const)('refuses %s without asking Flutterwave', async (_, overrides) => {
    const fw = flutterwave(ok(charge()))
    expect(await checkPayment(fw, { ...FACTS, ...overrides })).toMatchObject({
      kind: 'refused',
      code: 'PAYMENT_NOT_VERIFIED',
    })
    expect(fw.verifyTransaction).not.toHaveBeenCalled()
  })

  it('refuses when there is no payment at all', async () => {
    expect(await checkPayment(flutterwave(ok(charge())), null)).toMatchObject({ kind: 'refused' })
  })

  it.each([
    ['another reference — a charge from another app on the shared account', { txRef: 'PAIDLY-9' }],
    ['another amount than we recorded', { amountKobo: 100 }],
    ['another currency', { currency: 'USD' }],
    ['a failed charge', { status: 'failed' }],
  ] as const)('refuses a charge at Flutterwave with %s', async (_, overrides) => {
    expect(await checkPayment(flutterwave(ok(charge(overrides))), FACTS)).toMatchObject({
      kind: 'refused',
      code: 'PAYMENT_NOT_VERIFIED',
    })
  })

  it('refuses a charge Flutterwave has never heard of', async () => {
    const fw = flutterwave({ kind: 'rejected', code: 'FLW_HTTP_400', message: 'No transaction' })
    expect(await checkPayment(fw, FACTS)).toMatchObject({ kind: 'refused' })
  })

  it('reports an outage as unknown, to be asked again', async () => {
    const fw = flutterwave({ kind: 'unknown', code: 'FLW_NO_ANSWER', message: 'timeout' })
    expect(await checkPayment(fw, FACTS)).toMatchObject({ kind: 'unknown', code: 'FLW_NO_ANSWER' })
  })
})
