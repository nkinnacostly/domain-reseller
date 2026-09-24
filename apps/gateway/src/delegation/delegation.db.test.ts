import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDelegationStore, type DelegationStore } from './store'

/**
 * Migration 26's delegation functions, run for real against the hosted
 * project (FR-D5): which domains are due, what a check records, and when it
 * logs an event. The resolvers are not asked; the results are made up.
 *
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/delegation/delegation.db.test.ts
 *
 * The functions only touch live rows (test_mode = false), so this creates one
 * live domain for its own throwaway e2e-* user — plus a sandbox twin that must
 * be left alone — and deletes both, and the user, afterwards.
 */

const enabled = process.env.DB_TESTS === '1'

function readEnv(): Record<string, string> {
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url))
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, '')]
      }),
  )
}

const DAY = 86_400_000
const NS = ['ns1.e2e-delegation.test', 'ns2.e2e-delegation.test']
const SEEN = [
  { resolver: 'Cloudflare', state: 'answered' as const, nameservers: NS },
  { resolver: 'Google', state: 'answered' as const, nameservers: NS },
]

describe.skipIf(!enabled)('delegation checks against the database', () => {
  let db: SupabaseClient<Database>
  let store: DelegationStore
  let userId = ''
  let liveId = ''
  let sandboxId = ''
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const name = `e2edeleg${stamp}.com`

  async function domain(id: string) {
    const { data } = await db
      .from('domains')
      .select('delegation_status, delegation_checked_at')
      .eq('id', id)
      .single()
    return data
  }

  async function events(id: string) {
    const { data } = await db
      .from('domain_events')
      .select('event_type, payload')
      .eq('domain_id', id)
      .like('event_type', 'delegation_%')
      .order('id')
    return data ?? []
  }

  beforeAll(async () => {
    const env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    store = createDelegationStore(db)
    const { data: user, error } = await db.auth.admin.createUser({
      email: `e2e-delegation-${stamp}@example.com`,
      password: `e2e-${stamp}-Pw-9`,
      email_confirm: true,
    })
    if (error) throw error
    userId = user.user.id

    const row = (testMode: boolean) => ({
      user_id: userId,
      domain_name: name,
      tld: 'com',
      source: 'registration',
      test_mode: testMode,
      local_status: 'active' as const,
      registered_at: new Date(Date.now() - DAY).toISOString(),
      expires_at: new Date(Date.now() + 364 * DAY).toISOString(),
      nameservers: NS,
      delegation_status: 'pending' as const,
    })
    const { data: rows, error: insertError } = await db
      .from('domains')
      .insert([row(false), row(true)])
      .select('id, test_mode')
    if (insertError) throw insertError
    liveId = rows.find((r) => !r.test_mode)?.id ?? ''
    sandboxId = rows.find((r) => r.test_mode)?.id ?? ''

    const { error: eventError } = await db.from('domain_events').insert({
      domain_id: liveId,
      event_type: 'nameservers_applied',
      actor_type: 'system',
      payload: { nameservers: NS },
    })
    if (eventError) throw eventError
  })

  afterAll(async () => {
    if (!db) return
    const ids = [liveId, sandboxId].filter(Boolean)
    if (ids.length) await db.from('domains').delete().in('id', ids)
    if (userId) await db.auth.admin.deleteUser(userId)
  })

  it('lists a live domain that has never been checked, and never a sandbox one', async () => {
    const due = await store.due(500, 6)
    expect(due).toContainEqual({ id: liveId, domainName: name, nameservers: NS, status: 'pending' })
    expect(due.map((d) => d.id)).not.toContain(sandboxId)
  })

  it('finds when the domain’s nameservers last changed', async () => {
    const changes = await store.lastChanges([liveId])
    expect(Date.now() - (changes.get(liveId)?.getTime() ?? 0)).toBeLessThan(10 * 60_000)
  })

  it('refuses undelegated as the result of a check', async () => {
    const { error } = await db.rpc('record_delegation_checks', {
      p_results: [{ domain_id: liveId, status: 'undelegated', observed: [] }],
    })
    expect(error?.message).toMatch(/verified, failed or pending/)
  })

  it('records a verified domain with what was seen, and logs it once', async () => {
    await expect(
      store.record([{ domainId: liveId, status: 'verified', observed: SEEN }]),
    ).resolves.toBe(1)
    const after = await domain(liveId)
    expect(after?.delegation_status).toBe('verified')
    expect(after?.delegation_checked_at).not.toBeNull()
    expect(await events(liveId)).toEqual([
      { event_type: 'delegation_verified', payload: { observed: SEEN } },
    ])

    await store.record([{ domainId: liveId, status: 'verified', observed: SEEN }])
    expect(await events(liveId)).toHaveLength(1)
  })

  it('rests a checked domain until it is due again', async () => {
    expect((await store.due(500, 6)).map((d) => d.id)).not.toContain(liveId)
  })

  it('logs a failure, and records pending without an event', async () => {
    const nothing = [
      { resolver: 'Cloudflare', state: 'nxdomain' as const },
      { resolver: 'Google', state: 'nxdomain' as const },
    ]
    await store.record([{ domainId: liveId, status: 'failed', observed: nothing }])
    await store.record([{ domainId: liveId, status: 'pending', observed: [] }])
    expect((await domain(liveId))?.delegation_status).toBe('pending')
    expect((await events(liveId)).map((event) => event.event_type)).toEqual([
      'delegation_verified',
      'delegation_failed',
    ])
  })

  it('leaves a sandbox domain alone even when named', async () => {
    await expect(
      store.record([{ domainId: sandboxId, status: 'verified', observed: SEEN }]),
    ).resolves.toBe(0)
    expect(await domain(sandboxId)).toEqual({
      delegation_status: 'pending',
      delegation_checked_at: null,
    })
  })

  it('is closed to everything but our server', async () => {
    const env = readEnv()
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    expect(
      (await anon.rpc('domains_for_delegation_check', { p_limit: 1, p_every_hours: 1 })).error,
    ).not.toBeNull()
    expect((await anon.rpc('record_delegation_checks', { p_results: [] })).error).not.toBeNull()
  })
})
