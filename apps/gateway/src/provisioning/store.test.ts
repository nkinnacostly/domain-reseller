import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createSupabaseStore, toClaimedJob } from './store'

/** Records the calls the store makes; the functions themselves are in queue.db.test.ts. */
function fakeClient(answer: { data?: unknown; error?: { message: string } | null } = {}) {
  const calls: { fn: string; args: unknown }[] = []
  const result = { data: answer.data ?? null, error: answer.error ?? null }
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return Promise.resolve(result)
    },
    from: (table: string) => ({
      insert: (row: unknown) => {
        calls.push({ fn: `insert:${table}`, args: row })
        return Promise.resolve(result)
      },
    }),
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

const ROW = {
  id: 'j1',
  kind: 'register_domain',
  attempts: 1,
  test_mode: true,
  domain_id: 'd1',
  domain_name: 'example.com',
  local_status: 'pending',
  privacy: false,
  registrant: { firstName: 'Ada' },
  pending_nameservers: null,
  period_years: 2,
} as const

describe('Supabase job store', () => {
  it('claims one side of the queue, or one job', async () => {
    const { client, calls } = fakeClient({ data: ROW })
    const store = createSupabaseStore(client)
    await expect(store.claim('w', true, 300)).resolves.toEqual(toClaimedJob(ROW))
    await store.claim('w', true, 300, 'j9')
    expect(calls).toEqual([
      { fn: 'claim_job', args: { p_worker: 'w', p_test_mode: true, p_lease_seconds: 300 } },
      {
        fn: 'claim_job',
        args: { p_worker: 'w', p_test_mode: true, p_lease_seconds: 300, p_job_id: 'j9' },
      },
    ])
  })

  it('returns nothing when nothing is due', async () => {
    const { client } = fakeClient({ data: null })
    await expect(createSupabaseStore(client).claim('w', false, 300)).resolves.toBeNull()
  })

  it('passes nulls through where the registry had no answer', async () => {
    const { client, calls } = fakeClient()
    const store = createSupabaseStore(client)
    await store.completeRegistration('j1', {
      domain: {
        registeredAt: null,
        expiresAt: null,
        nameservers: [],
        transferLock: true,
        privacy: false,
      },
      recovered: true,
      nameserverResult: 'none',
      nameserverCode: null,
    })
    await store.recordNameserverChange('j1', ['a.test', 'b.test'], null, 'NAMESERVER_INVALID')
    expect(calls[0]?.args).toMatchObject({
      p_registered_at: null,
      p_expires_at: null,
      p_recovered: true,
    })
    expect(calls[1]).toEqual({
      fn: 'record_nameserver_change',
      args: {
        p_job_id: 'j1',
        p_attempted: ['a.test', 'b.test'],
        p_applied: null,
        p_code: 'NAMESERVER_INVALID',
      },
    })
  })

  it('records a supplier call as a row', async () => {
    const { client, calls } = fakeClient()
    await createSupabaseStore(client).recordCall('j1', 'ote', {
      operation: 'GetDetails',
      domainName: 'example.com',
      outcome: 'not_found',
      httpStatus: 404,
      errorCode: null,
      message: null,
      durationMs: 12,
    })
    expect(calls[0]).toEqual({
      fn: 'insert:supplier_calls',
      args: expect.objectContaining({
        job_id: 'j1',
        environment: 'ote',
        outcome: 'not_found',
        duration_ms: 12,
      }),
    })
  })

  it('throws when the database refuses, so the job is left for its lease', async () => {
    const { client } = fakeClient({ error: { message: 'permission denied' } })
    const store = createSupabaseStore(client)
    await expect(store.reschedule('j1', 30, 'TIMEOUT', 'x')).rejects.toThrow('permission denied')
    await expect(store.fail('j1', 'X', 'x', true)).rejects.toThrow('permission denied')
    await expect(store.claim('w', true, 300)).rejects.toThrow('permission denied')
  })
})
