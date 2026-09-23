import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createReconcileStore } from './store'

/** Records what the store sends; the functions themselves are in reconcile.db.test.ts. */
function fakeClient(
  answers: { rpc?: unknown; rows?: unknown[][]; error?: { message: string } } = {},
) {
  const calls: { fn: string; args: unknown }[] = []
  const pages = [...(answers.rows ?? [[]])]
  const error = answers.error ?? null
  const query = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    order: () => query,
    range: (from: number, to: number) => {
      calls.push({ fn: 'range', args: [from, to] })
      return Promise.resolve({ data: pages.shift() ?? [], error })
    },
  }
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return Promise.resolve({ data: answers.rpc ?? null, error })
    },
    from: () => query,
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

const ROW = {
  id: 'd1',
  domain_name: 'example.com',
  local_status: 'active',
  expires_at: '2027-09-23T08:44:10+00:00',
  nameservers: ['ns1.domainnameapi.com'],
  pending_nameservers: null,
  auto_renew: false,
  transfer_lock: true,
  privacy_enabled: true,
}

describe('reconcile store', () => {
  it('starts a run with the interval it was given', async () => {
    const { client, calls } = fakeClient({ rpc: 'run-1' })
    await expect(createReconcileStore(client).begin(true, 3600)).resolves.toBe('run-1')
    expect(calls).toEqual([
      { fn: 'begin_reconcile', args: { p_test_mode: true, p_min_interval_seconds: 3600 } },
    ])
  })

  it('pages through our domains until a short page', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => ({ ...ROW, id: `d${index}` }))
    const { client, calls } = fakeClient({ rows: [full, [ROW]] })
    const ours = await createReconcileStore(client).loadOurs(true)
    expect(ours).toHaveLength(1001)
    expect(ours.at(-1)).toEqual({
      id: 'd1',
      domainName: 'example.com',
      localStatus: 'active',
      expiresAt: '2027-09-23T08:44:10+00:00',
      nameservers: ['ns1.domainnameapi.com'],
      pendingNameservers: null,
      autoRenew: false,
      transferLock: true,
      privacy: true,
    })
    expect(calls.map((call) => call.args)).toEqual([
      [0, 999],
      [1000, 1999],
    ])
  })

  it('sends decisions as the database function expects them', async () => {
    const { client, calls } = fakeClient({ rpc: 1 })
    await createReconcileStore(client).record(
      'run-1',
      {
        updates: [
          { domainId: 'd1', registryStatus: 'Active', renewalMode: 'AutoRenew', events: [] },
        ],
        findings: [{ domainId: null, domainName: 'stray.com', kind: 'unknown_domain', detail: {} }],
      },
      2,
    )
    expect(calls[0]).toEqual({
      fn: 'record_reconciliation',
      args: {
        p_run_id: 'run-1',
        p_updates: [
          {
            domain_id: 'd1',
            registry_status: 'Active',
            renewal_mode: 'AutoRenew',
            expires_at: null,
            nameservers: null,
            transfer_lock: null,
            privacy: null,
            events: [],
          },
        ],
        p_findings: [
          { domain_id: null, domain_name: 'stray.com', kind: 'unknown_domain', detail: {} },
        ],
        p_complete: true,
        p_domains_seen: 2,
      },
    })
  })

  it('throws when the database refuses', async () => {
    const { client } = fakeClient({ error: { message: 'permission denied' } })
    const store = createReconcileStore(client)
    await expect(store.begin(true, 0)).rejects.toThrow('permission denied')
    await expect(store.loadOurs(true)).rejects.toThrow('permission denied')
    await expect(store.fail('run-1', 'x')).rejects.toThrow('permission denied')
    await expect(store.record('run-1', { updates: [], findings: [] }, 0)).rejects.toThrow(
      'permission denied',
    )
  })
})
