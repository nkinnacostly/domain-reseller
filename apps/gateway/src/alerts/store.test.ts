import { describe, expect, it, vi } from 'vitest'
import { fakeRpcClient } from '../test-support/fake-supabase'
import { createAlertStore } from './store'

/** ops_alerts keys for the admin links (ADMIN-SPEC §4.5), read with the service key. */
function withKeys(
  rpcClient: ReturnType<typeof fakeRpcClient>,
  answer: { data: unknown; error: { message: string } | null },
) {
  const builder = { select: vi.fn(() => builder), in: vi.fn(async () => answer) }
  const from = vi.fn(() => builder)
  return { client: { ...(rpcClient.client as object), from } as never, from, builder }
}

describe('createAlertStore', () => {
  it('adds each alert’s key from ops_alerts, for the admin link', async () => {
    const rpcClient = fakeRpcClient({
      sync_alerts: {
        data: [
          {
            id: 7,
            type: 'new',
            severity: 'critical',
            kind: 'job_needs_attention',
            summary: 'Job',
            first_seen_at: '2026-10-02T10:00:00Z',
          },
          {
            id: 8,
            type: 'new',
            severity: 'warning',
            kind: 'float_low',
            summary: 'Float',
            first_seen_at: '2026-10-02T10:00:00Z',
          },
        ],
      },
    })
    const { client, from, builder } = withKeys(rpcClient, {
      data: [{ id: '7', key: 'job:8dbd7ea2-c535-4a4a-a091-e202d9185a20' }],
      error: null,
    })
    const due = await createAlertStore(client).sync(false)
    expect(from).toHaveBeenCalledWith('ops_alerts')
    expect(builder.select).toHaveBeenCalledWith('id, key')
    expect(builder.in).toHaveBeenCalledWith('id', [7, 8])
    expect(due.map((alert) => alert.key)).toEqual([
      'job:8dbd7ea2-c535-4a4a-a091-e202d9185a20',
      undefined,
    ])
  })

  it('still sends alerts, unlinked, when the keys cannot be read', async () => {
    const rpcClient = fakeRpcClient({
      sync_alerts: {
        data: [
          {
            id: 7,
            type: 'new',
            severity: 'critical',
            kind: 'x',
            summary: 'Job',
            first_seen_at: '2026-10-02T10:00:00Z',
          },
        ],
      },
    })
    const { client } = withKeys(rpcClient, { data: null, error: { message: 'denied' } })
    expect(await createAlertStore(client).sync(false)).toEqual([
      expect.not.objectContaining({ key: expect.anything() }),
    ])
  })

  it('beats, records the float, syncs and marks what was sent', async () => {
    const rpcClient = fakeRpcClient({
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
    const { rpc } = rpcClient
    const { client } = withKeys(rpcClient, { data: [], error: null })
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
