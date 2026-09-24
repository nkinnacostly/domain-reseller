import { describe, expect, it } from 'vitest'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { createPaymentStore } from './store'

const CHARGE = {
  orderId: 'order-1',
  providerReference: '4242',
  amountKobo: 1_978_000,
  currency: 'NGN',
  method: 'card',
  raw: { id: 4242, status: 'successful' },
}

describe('createPaymentStore', () => {
  it('reads the orders due a look, for one side', async () => {
    const { client, rpc } = fakeRpcClient({
      orders_to_check: {
        data: [
          {
            id: '0b8f7c1e-7a3b-4c7e-9a3e-1f2d3c4b5a69',
            tx_ref: 'MDH-1',
            total_kobo: '1978000',
            order_number: 'ND-1',
            created_at: '2026-09-24T10:00:00+00:00',
            known_references: ['4242'],
          },
        ],
      },
    })
    expect(await createPaymentStore(client).ordersToCheck(false, 20)).toEqual([
      {
        id: '0b8f7c1e-7a3b-4c7e-9a3e-1f2d3c4b5a69',
        txRef: 'MDH-1',
        totalKobo: 1_978_000,
        orderNumber: 'ND-1',
        createdAt: '2026-09-24T10:00:00+00:00',
        knownReferences: ['4242'],
      },
    ])
    expect(rpc).toHaveBeenCalledWith('orders_to_check', { p_test_mode: false, p_limit: 20 })
  })

  it('refuses a row it does not recognise rather than guessing', async () => {
    const { client } = fakeRpcClient({
      orders_to_check: { data: [{ id: 'not-a-uuid', tx_ref: '', total_kobo: -1 }] },
    })
    await expect(createPaymentStore(client).ordersToCheck(true, 20)).rejects.toThrow()
  })

  it('records through the same functions as the web app', async () => {
    const { client, rpc } = fakeRpcClient()
    const store = createPaymentStore(client)
    await store.recordPayment(CHARGE)
    await store.recordUnderpayment(CHARGE)
    await store.recordIncident('unrecorded_payment', 'order-1', '4242', { amount_kobo: 1 })
    const args = {
      p_order_id: 'order-1',
      p_provider_reference: '4242',
      p_amount_kobo: 1_978_000,
      p_currency: 'NGN',
      p_method: 'card',
      p_raw: { id: 4242, status: 'successful' },
    }
    expect(rpc.mock.calls).toEqual([
      ['record_order_payment', args],
      ['record_underpayment', args],
      [
        'record_payment_incident',
        {
          p_kind: 'unrecorded_payment',
          p_order_id: 'order-1',
          p_provider_reference: '4242',
          p_detail: { amount_kobo: 1 },
        },
      ],
    ])
  })

  it('throws what the database refused', async () => {
    const refused = { error: { message: 'db down' } }
    const { client } = fakeRpcClient({
      orders_to_check: refused,
      record_order_payment: refused,
      record_underpayment: refused,
      record_payment_incident: refused,
    })
    const store = createPaymentStore(client)
    await expect(store.ordersToCheck(true, 1)).rejects.toThrow('db down')
    await expect(store.recordPayment(CHARGE)).rejects.toThrow('db down')
    await expect(store.recordUnderpayment(CHARGE)).rejects.toThrow('db down')
    await expect(store.recordIncident('tx_ref_mismatch', 'o', 'r', {})).rejects.toThrow('db down')
  })
})
