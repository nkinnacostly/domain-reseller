import { describe, expect, it } from 'vitest'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { createAlertStore } from './store'

describe('createAlertStore', () => {
  it('beats, records the float, syncs and marks what was sent', async () => {
    const { client, rpc } = fakeRpcClient({
      sync_alerts: {
        data: [
          {
            id: '7',
            type: 'new',
            severity: 'critical',
            kind: 'payment_underpayment',
            summary: 'Payment incident: underpayment',
            first_seen_at: '2026-09-24T10:00:00Z',
          },
        ],
      },
    })
    const store = createAlertStore(client)
    await store.heartbeat('gateway:ote', true, { version: 1 })
    await store.recordBalance(true, 25.5)
    expect(await store.sync(true)).toEqual([
      expect.objectContaining({ id: 7, type: 'new', firstSeenAt: '2026-09-24T10:00:00Z' }),
    ])
    await store.markNotified([7], [3])
    expect(rpc.mock.calls).toEqual([
      ['record_heartbeat', { p_name: 'gateway:ote', p_test_mode: true, p_detail: { version: 1 } }],
      ['record_supplier_balance', { p_test_mode: true, p_balance_usd: 25.5 }],
      ['sync_alerts', { p_test_mode: true }],
      ['mark_alerts_notified', { p_alert_ids: [7], p_resolved_ids: [3] }],
    ])
  })

  it('throws what the database refused', async () => {
    const refused = { error: { message: 'db down' } }
    const { client } = fakeRpcClient({ sync_alerts: refused, record_heartbeat: refused })
    const store = createAlertStore(client)
    await expect(store.sync(true)).rejects.toThrow('db down')
    await expect(store.heartbeat('g', true, {})).rejects.toThrow('db down')
  })
})
