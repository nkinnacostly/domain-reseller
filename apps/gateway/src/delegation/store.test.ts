import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createDelegationStore, NAMESERVER_CHANGE_EVENTS } from './store'

/** Records what the store sends; the functions themselves are in delegation.db.test.ts. */
function fakeClient(
  answers: { rpc?: unknown; rows?: unknown[]; error?: { message: string } } = {},
) {
  const calls: { fn: string; args: unknown[] }[] = []
  const error = answers.error ?? null
  const query = {
    select: (...args: unknown[]) => {
      calls.push({ fn: 'select', args })
      return query
    },
    in: (...args: unknown[]) => {
      calls.push({ fn: 'in', args })
      return query
    },
    order: (...args: unknown[]) => {
      calls.push({ fn: 'order', args })
      return Promise.resolve({ data: answers.rows ?? [], error })
    },
  }
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args: [args] })
      return Promise.resolve({ data: answers.rpc ?? null, error })
    },
    from: (table: string) => {
      calls.push({ fn: 'from', args: [table] })
      return query
    },
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

describe('delegation store', () => {
  it('asks for due domains with the batch size and the resting time', async () => {
    const { client, calls } = fakeClient({
      rpc: [
        {
          domain_id: 'd1',
          domain_name: 'example.com',
          nameservers: ['ns1.host.test'],
          delegation_status: 'pending',
        },
        {
          domain_id: 'd2',
          domain_name: 'other.com',
          nameservers: null,
          delegation_status: 'verified',
        },
      ],
    })
    await expect(createDelegationStore(client).due(500, 6)).resolves.toEqual([
      { id: 'd1', domainName: 'example.com', nameservers: ['ns1.host.test'], status: 'pending' },
      { id: 'd2', domainName: 'other.com', nameservers: [], status: 'verified' },
    ])
    expect(calls).toEqual([
      { fn: 'domains_for_delegation_check', args: [{ p_limit: 500, p_every_hours: 6 }] },
    ])
  })

  it('has nothing due when the function returns nothing', async () => {
    const { client } = fakeClient()
    await expect(createDelegationStore(client).due(500, 6)).resolves.toEqual([])
  })

  it('takes each domain’s latest nameserver change from its activity log', async () => {
    const { client, calls } = fakeClient({
      rows: [
        { domain_id: 'd1', created_at: '2026-09-28T10:00:00Z' },
        { domain_id: 'd2', created_at: '2026-09-27T10:00:00Z' },
        { domain_id: 'd1', created_at: '2026-09-01T10:00:00Z' },
      ],
    })
    const changes = await createDelegationStore(client).lastChanges(['d1', 'd2', 'd3'])
    expect([...changes]).toEqual([
      ['d1', new Date('2026-09-28T10:00:00Z')],
      ['d2', new Date('2026-09-27T10:00:00Z')],
    ])
    expect(calls).toContainEqual({ fn: 'from', args: ['domain_events'] })
    expect(calls).toContainEqual({ fn: 'in', args: ['domain_id', ['d1', 'd2', 'd3']] })
    expect(calls).toContainEqual({ fn: 'in', args: ['event_type', NAMESERVER_CHANGE_EVENTS] })
    expect(calls).toContainEqual({ fn: 'order', args: ['created_at', { ascending: false }] })
  })

  it('does not ask about no domains', async () => {
    const { client, calls } = fakeClient()
    await expect(createDelegationStore(client).lastChanges([])).resolves.toEqual(new Map())
    expect(calls).toEqual([])
  })

  it('reads no changes from an empty answer', async () => {
    const { client } = fakeClient()
    ;(client as unknown as { from: () => unknown }).from = () => ({
      select: () => ({
        in: () => ({ in: () => ({ order: async () => ({ data: null, error: null }) }) }),
      }),
    })
    await expect(createDelegationStore(client).lastChanges(['d1'])).resolves.toEqual(new Map())
  })

  it('records results as the database function expects them', async () => {
    const { client, calls } = fakeClient({ rpc: 1 })
    const observed = [{ resolver: 'Google', state: 'nxdomain' as const }]
    await expect(
      createDelegationStore(client).record([{ domainId: 'd1', status: 'failed', observed }]),
    ).resolves.toBe(1)
    expect(calls).toEqual([
      {
        fn: 'record_delegation_checks',
        args: [{ p_results: [{ domain_id: 'd1', status: 'failed', observed }] }],
      },
    ])
  })

  it('records nothing for no results, and counts none', async () => {
    const { client, calls } = fakeClient()
    await expect(createDelegationStore(client).record([])).resolves.toBe(0)
    expect(calls).toEqual([])
    const answered = fakeClient({ rpc: null })
    await expect(
      createDelegationStore(answered.client).record([
        { domainId: 'd1', status: 'pending', observed: [] },
      ]),
    ).resolves.toBe(0)
  })

  it('passes database errors on', async () => {
    const { client } = fakeClient({ error: { message: 'permission denied' } })
    const store = createDelegationStore(client)
    await expect(store.due(1, 6)).rejects.toThrow('permission denied')
    await expect(store.lastChanges(['d1'])).rejects.toThrow('permission denied')
    await expect(
      store.record([{ domainId: 'd1', status: 'pending', observed: [] }]),
    ).rejects.toThrow('permission denied')
  })
})
