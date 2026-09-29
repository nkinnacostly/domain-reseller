import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import type { CurrentTld, TldRow } from './catalogue'
import { CATALOGUE_HEARTBEAT, createCatalogueStore, createRunLog } from './store'

/** Records what the store sends; the table itself is the hosted project's. */
function fakeClient(
  answers: {
    pages?: unknown[][]
    heartbeat?: unknown
    error?: { message: string } | null
    failOn?: 'upsert' | 'update' | 'range' | 'rpc' | 'maybeSingle'
  } = {},
) {
  const calls: { fn: string; args: unknown[] }[] = []
  const pages = [...(answers.pages ?? [[]])]
  const fail = (fn: string) =>
    answers.failOn === fn ? (answers.error ?? { message: 'boom' }) : null
  const query = {
    select: (...args: unknown[]) => {
      calls.push({ fn: 'select', args })
      return query
    },
    order: () => query,
    eq: (...args: unknown[]) => {
      calls.push({ fn: 'eq', args })
      return query
    },
    in: (...args: unknown[]) => {
      calls.push({ fn: 'in', args })
      return Promise.resolve({ error: fail('update') })
    },
    range: (...args: unknown[]) => {
      calls.push({ fn: 'range', args })
      return Promise.resolve({ data: pages.length > 0 ? pages.shift() : [], error: fail('range') })
    },
    maybeSingle: () =>
      Promise.resolve({ data: answers.heartbeat ?? null, error: fail('maybeSingle') }),
    upsert: (...args: unknown[]) => {
      calls.push({ fn: 'upsert', args })
      return Promise.resolve({ error: fail('upsert') })
    },
    update: (...args: unknown[]) => {
      calls.push({ fn: 'update', args })
      return query
    },
  }
  const client = {
    from: (table: string) => {
      calls.push({ fn: 'from', args: [table] })
      return query
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args: [args] })
      return Promise.resolve({ data: null, error: fail('rpc') })
    },
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

const tld = (name: string) => ({ name }) as unknown as CurrentTld
const row = (name: string) => ({ name, register_usd: 1 }) as unknown as TldRow

describe('catalogue store', () => {
  it('reads the whole table, a page at a time', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => tld(`t${i}`))
    const { client, calls } = fakeClient({ pages: [full, [tld('zz')]] })
    const rows = await createCatalogueStore(client).load()
    expect(rows).toHaveLength(1001)
    expect(calls.filter((call) => call.fn === 'range').map((call) => call.args)).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(calls.find((call) => call.fn === 'select')?.args[0]).toBe('*')
  })

  it('keeps the sync’s columns, and reads periods a database does not have yet as none', async () => {
    const before37 = {
      name: 'com',
      register_usd: 11.31,
      min_period: 1,
      max_period: 10,
      is_sellable: true,
      featured_rank: 1,
    }
    const { client } = fakeClient({ pages: [[before37]] })
    const [read] = await createCatalogueStore(client).load()
    expect(read).toMatchObject({
      name: 'com',
      register_usd: 11.31,
      register_periods: null,
      renew_periods: null,
      is_sellable: true,
    })
    expect(read).not.toHaveProperty('featured_rank')
  })

  it('reads an empty answer as an empty table', async () => {
    const { client } = fakeClient({ pages: [null as never] })
    await expect(createCatalogueStore(client).load()).resolves.toEqual([])
  })

  it('says when the table cannot be read', async () => {
    const { client } = fakeClient({ failOn: 'range', error: { message: 'permission denied' } })
    await expect(createCatalogueStore(client).load()).rejects.toThrow(
      'Could not read the current catalogue: permission denied',
    )
  })

  it('writes in batches, each row stamped with the sync time', async () => {
    const { client, calls } = fakeClient()
    await createCatalogueStore(client, 2).upsert(
      [row('a'), row('b'), row('c')],
      '2026-09-28T06:00:00Z',
    )
    const upserts = calls.filter((call) => call.fn === 'upsert')
    expect(upserts.map((call) => (call.args[0] as { name: string }[]).map((r) => r.name))).toEqual([
      ['a', 'b'],
      ['c'],
    ])
    expect(upserts[0]?.args[0]).toEqual([
      { name: 'a', register_usd: 1, synced_at: '2026-09-28T06:00:00Z' },
      { name: 'b', register_usd: 1, synced_at: '2026-09-28T06:00:00Z' },
    ])
    expect(upserts[0]?.args[1]).toEqual({ onConflict: 'name' })
  })

  it('says where a write failed', async () => {
    const { client } = fakeClient({ failOn: 'upsert' })
    await expect(createCatalogueStore(client).upsert([row('a')], 'now')).rejects.toThrow(
      'Upsert failed at row 0: boom',
    )
  })

  it('stops selling retired extensions, in batches, without deleting them', async () => {
    const { client, calls } = fakeClient()
    await createCatalogueStore(client, 2).retire(['a', 'b', 'c'])
    expect(calls.filter((call) => call.fn === 'update').map((call) => call.args[0])).toEqual([
      { is_sellable: false },
      { is_sellable: false },
    ])
    expect(calls.filter((call) => call.fn === 'in').map((call) => call.args)).toEqual([
      ['name', ['a', 'b']],
      ['name', ['c']],
    ])
  })

  it('says when retiring failed', async () => {
    const { client } = fakeClient({ failOn: 'update' })
    await expect(createCatalogueStore(client).retire(['a'])).rejects.toThrow(
      'Could not retire removed extensions: boom',
    )
  })
})

describe('catalogue run log', () => {
  it('has nothing before the first run', async () => {
    const { client, calls } = fakeClient()
    await expect(createRunLog(client).last()).resolves.toBeNull()
    expect(calls).toContainEqual({ fn: 'from', args: ['service_heartbeats'] })
    expect(calls).toContainEqual({ fn: 'eq', args: ['name', CATALOGUE_HEARTBEAT] })
  })

  it('reads when the last run was and what came of it', async () => {
    const { client } = fakeClient({
      heartbeat: { beat_at: '2026-09-28T06:00:00Z', detail: { outcome: 'written' } },
    })
    await expect(createRunLog(client).last()).resolves.toEqual({
      at: new Date('2026-09-28T06:00:00Z'),
      detail: { outcome: 'written' },
    })
  })

  it('treats a detail it cannot read as empty', async () => {
    const { client } = fakeClient({ heartbeat: { beat_at: '2026-09-28T06:00:00Z', detail: [1] } })
    await expect(createRunLog(client).last()).resolves.toMatchObject({ detail: {} })
  })

  it('says when the last run cannot be read', async () => {
    const { client } = fakeClient({ failOn: 'maybeSingle' })
    await expect(createRunLog(client).last()).rejects.toThrow(
      'Could not read the last catalogue sync: boom',
    )
  })

  it('records the outcome as the live catalogue’s heartbeat', async () => {
    const { client, calls } = fakeClient()
    await createRunLog(client).record({ outcome: 'unchanged' })
    expect(calls).toContainEqual({
      fn: 'record_heartbeat',
      args: [
        { p_name: 'catalogue:production', p_test_mode: false, p_detail: { outcome: 'unchanged' } },
      ],
    })
  })

  it('says when the outcome could not be recorded', async () => {
    const { client } = fakeClient({ failOn: 'rpc' })
    await expect(createRunLog(client).record({})).rejects.toThrow(
      'Could not record the catalogue sync: boom',
    )
  })
})
