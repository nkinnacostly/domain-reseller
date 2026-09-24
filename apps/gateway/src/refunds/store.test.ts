import { describe, expect, it } from 'vitest'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { createRefundStore, toClaimedRefund } from './store'

const ROW = {
  id: '0b8f7c1e-7a3b-4c7e-9a3e-1f2d3c4b5a69',
  action: 'send',
  reason: 'registration_failed',
  amount_kobo: '1967250',
  attempts: 1,
  test_mode: true,
  provider_refund_id: null,
  provider_called_at: null,
  submitted_at: null,
  transaction_id: '908790',
  flw_ref: 'FLW-MOCK-908790',
  charged_kobo: 3934500,
  charged_at: '2026-09-24T11:00:00+00:00',
  order_tx_ref: 'MDH-2f1c1a3e-8d7b-4c55-9a0e-1f2d3c4b5a69',
  order_number: 'ND-001050',
  domain_name: 'getpaid.com',
  held_by_other_account: false,
  known_provider_refund_ids: [],
  other_refunds_kobo: 0,
}

describe('toClaimedRefund', () => {
  it('reads what claim_refund returns, bigints included', () => {
    expect(toClaimedRefund(ROW)).toMatchObject({
      id: ROW.id,
      action: 'send',
      amountKobo: 1_967_250,
      chargedKobo: 3_934_500,
      transactionId: '908790',
      orderTxRef: ROW.order_tx_ref,
      heldByOtherAccount: false,
      knownProviderRefundIds: [],
    })
  })

  it('reads what a renewal refund needs, and leaves it empty for others', () => {
    expect(
      toClaimedRefund({
        ...ROW,
        reason: 'renewal_failed',
        renewal_baseline: '2027-09-23T07:00:00+00:00',
        renewal_years: 2,
      }),
    ).toMatchObject({
      reason: 'renewal_failed',
      renewalBaseline: '2027-09-23T07:00:00+00:00',
      renewalYears: 2,
    })
    expect(toClaimedRefund(ROW)).toMatchObject({ renewalBaseline: null, renewalYears: null })
  })

  it('refuses anything it does not recognise rather than guessing', () => {
    expect(() => toClaimedRefund({ ...ROW, action: 'refund_everything' })).toThrow()
    expect(() => toClaimedRefund({ ...ROW, amount_kobo: -1 })).toThrow()
    expect(() => toClaimedRefund({ ...ROW, transaction_id: '' })).toThrow()
    expect(() => toClaimedRefund({ ...ROW, order_tx_ref: '' })).toThrow()
    expect(() => toClaimedRefund({ ...ROW, held_by_other_account: undefined })).toThrow()
  })
})

describe('createRefundStore', () => {
  it('claims with the worker, the side and the lease, and reads the answer', async () => {
    const { client, rpc } = fakeRpcClient({ claim_refund: { data: ROW } })
    const store = createRefundStore(client)
    expect(await store.claim('w-1', true, 300)).toMatchObject({ id: ROW.id, action: 'send' })
    expect(rpc).toHaveBeenCalledWith('claim_refund', {
      p_worker: 'w-1',
      p_test_mode: true,
      p_lease_seconds: 300,
    })
  })

  it('reports an empty queue as null', async () => {
    const { client } = fakeRpcClient()
    expect(await createRefundStore(client).claim('w-1', true, 300)).toBeNull()
  })

  it('names the worker on every call after the claim (migration 18)', async () => {
    const { client, rpc } = fakeRpcClient()
    const store = createRefundStore(client)
    await store.noteProviderCall('r', 'w-1')
    await store.submitted('r', 'w-1', 'flw-1', 'completed', 600)
    await store.complete('r', 'w-1', 'flw-1', 'completed-mpgs')
    await store.fail('r', 'w-1', 'X', 'why', true)
    await store.fail('r', 'w-1', 'AMOUNT_MISMATCH', 'short', true, 'flw-2')
    await store.reschedule('r', 'w-1', 300, 'X', 'why', true)
    for (const [, args] of rpc.mock.calls) {
      expect(args).toMatchObject({ p_refund_id: 'r', p_worker: 'w-1' })
    }
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'note_refund_provider_call',
      'record_refund_submitted',
      'complete_refund',
      'fail_refund',
      'fail_refund',
      'reschedule_refund',
    ])
    expect(rpc.mock.calls[3]?.[1]).not.toHaveProperty('p_provider_refund_id')
    expect(rpc.mock.calls[4]?.[1]).toMatchObject({ p_provider_refund_id: 'flw-2' })
  })

  it('throws what the database refused, so the worker never carries on as if it had worked', async () => {
    const refused = { error: { message: 'refund r is not claimed by w-1' } }
    const { client } = fakeRpcClient({
      claim_refund: refused,
      complete_refund: refused,
    })
    const store = createRefundStore(client)
    await expect(store.claim('w-1', true, 300)).rejects.toThrow(/not claimed/)
    await expect(store.complete('r', 'w-1', 'f', 's')).rejects.toThrow(/not claimed/)
  })
})
