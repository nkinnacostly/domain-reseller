import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RegistryListing } from '../provisioning/registrar'
import { compareWithRegistry, type OurDomain } from './compare'
import { createReconcileStore, type ReconcileStore } from './store'

/**
 * Migration 14's functions, run for real against the hosted project: a run
 * records drift, a second run resolves what it no longer sees, and the
 * registry's expiry reaches our domain with an event. The comparison is the
 * real one; only the registry listing is made up.
 *
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/reconcile/reconcile.db.test.ts
 *
 * It touches only its own rows, but a run resolves open sandbox-side drift it
 * does not see — keep it off a project with real sandbox drift to watch.
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
const NS = ['ns1.domainnameapi.com', 'ns2.domainnameapi.com']

describe.skipIf(!enabled)('reconciliation against the database', () => {
  let db: SupabaseClient<Database>
  let store: ReconcileStore
  let userId = ''
  let domainId = ''
  const runIds: string[] = []
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const held = `e2ecartrc${stamp}.com`
  const stray = `e2ecartrc${stamp}-stray.com`
  const soon = new Date(Date.now() + 20 * DAY).toISOString()
  const nextYear = new Date(Date.now() + 385 * DAY).toISOString()

  const ours = (): OurDomain => ({
    id: domainId,
    domainName: held,
    localStatus: 'active',
    expiresAt: soon,
    nameservers: NS,
    pendingNameservers: null,
    autoRenew: false,
    transferLock: true,
    privacy: false,
  })
  const listed = (over: Partial<RegistryListing> = {}): RegistryListing => ({
    domainName: held,
    status: 'Active',
    expiresAt: soon,
    nameservers: NS,
    transferLock: true,
    privacy: true,
    renewalMode: 'AutoRenew',
    ...over,
  })

  async function run(listing: RegistryListing[], domain: OurDomain) {
    const runId = await store.begin(true, 0)
    if (!runId) throw new Error('run not started')
    runIds.push(runId)
    const comparison = compareWithRegistry([domain], listing, { now: new Date() })
    await store.record(runId, comparison, listing.length)
    return runId
  }

  async function openDrift() {
    const { data } = await db
      .from('registry_drift')
      .select('domain_name, kind')
      .in('domain_name', [held, stray])
      .is('resolved_at', null)
    return (data ?? [])
      .map((row) => `${row.domain_name === held ? 'held' : 'stray'}:${row.kind}`)
      .sort()
  }

  beforeAll(async () => {
    const env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    store = createReconcileStore(db)
    const { data: user, error } = await db.auth.admin.createUser({
      email: `e2e-reconcile-${stamp}@example.com`,
      password: `e2e-${stamp}-Pw-9`,
      email_confirm: true,
    })
    if (error) throw error
    userId = user.user.id
    const { data: domain, error: domainError } = await db
      .from('domains')
      .insert({
        user_id: userId,
        domain_name: held,
        tld: 'com',
        source: 'registration',
        test_mode: true,
        local_status: 'active',
        registered_at: new Date(Date.now() - 345 * DAY).toISOString(),
        expires_at: soon,
        auto_renew: false,
        nameservers: NS,
      })
      .select('id')
      .single()
    if (domainError) throw domainError
    domainId = domain.id
  })

  afterAll(async () => {
    if (!db) return
    await db.from('registry_drift').delete().in('domain_name', [held, stray])
    if (runIds.length) await db.from('reconcile_runs').delete().in('id', runIds)
    if (domainId) await db.from('domains').delete().eq('id', domainId)
    if (userId) await db.auth.admin.deleteUser(userId)
  })

  it('records drift: supplier auto-renew ahead, and a domain we do not know', async () => {
    await run([listed(), listed({ domainName: stray })], ours())
    expect(await openDrift()).toEqual(['held:supplier_may_renew', 'stray:unknown_domain'])

    const { data } = await db
      .from('domains')
      .select('registry_status, registry_renewal_mode, registry_checked_at, privacy_enabled')
      .eq('id', domainId)
      .single()
    expect(data).toMatchObject({
      registry_status: 'Active',
      registry_renewal_mode: 'AutoRenew',
      privacy_enabled: true,
    })
    expect(data?.registry_checked_at).not.toBeNull()
  })

  it('does not start a second run while one is going', async () => {
    const first = await store.begin(true, 0)
    if (first) runIds.push(first)
    await expect(store.begin(true, 0)).resolves.toBeNull()
    if (first) await store.fail(first, 'test')
  })

  it('does not run again within the interval', async () => {
    await expect(store.begin(true, 3600)).resolves.toBeNull()
  })

  it('catches a renewal we did not make, takes the new expiry, and resolves what went away', async () => {
    await run([listed({ expiresAt: nextYear })], ours())
    expect(await openDrift()).toEqual(['held:supplier_renewed'])

    const { data: domain } = await db
      .from('domains')
      .select('expires_at')
      .eq('id', domainId)
      .single()
    expect(new Date(domain?.expires_at ?? 0).toISOString()).toBe(nextYear)

    const { data: events } = await db
      .from('domain_events')
      .select('event_type')
      .eq('domain_id', domainId)
    expect(events?.map((event) => event.event_type)).toContain('expiry_updated_from_registry')
  })

  it('is closed to everything but our server', async () => {
    const env = readEnv()
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    expect(
      (await anon.rpc('begin_reconcile', { p_test_mode: true, p_min_interval_seconds: 0 })).error,
    ).not.toBeNull()
    expect((await anon.from('registry_drift').select('id').limit(1)).data ?? []).toEqual([])
  })
})
