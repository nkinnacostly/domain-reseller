import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Registrar, RegistryDomain } from './registrar'
import { type ClaimedJob, createSupabaseStore, type JobStore } from './store'
import { createWorker } from './worker'

/**
 * The queue's database functions (migration 13), run for real: a paid order
 * enqueues its lines, the worker claims and records them, and the order,
 * lines, domains and events move together. Only the registry is faked.
 *
 * Needs the hosted project, so it runs only with DB_TESTS=1:
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/provisioning/queue.db.test.ts
 * It touches only the rows it creates — test users are `e2e-*@example.com`.
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

const REGISTRANT = {
  firstName: 'Ada',
  lastName: 'Obi',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '8031234567',
  addressLine1: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}
const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']
const NETLIFY = ['dns1.p01.nsone.net', 'dns2.p01.nsone.net']
const REGISTERED: RegistryDomain = {
  registeredAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2027-09-23T10:00:00.000Z',
  nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
  transferLock: true,
  privacy: false,
}

describe.skipIf(!enabled)('provisioning queue against the database', () => {
  let db: SupabaseClient<Database>
  let store: JobStore
  let userId = ''
  let orderId = ''
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const good = `e2ecartgw${stamp}a.com`
  const taken = `e2ecartgw${stamp}b.com`

  /** Registers `good` and refuses `taken`, recording each call as the real one does. */
  const registrarFor = (job: ClaimedJob): Registrar => ({
    async lookup(name) {
      await store.recordCall(job.id, 'ote', {
        operation: 'GetDetails',
        domainName: name,
        outcome: 'not_found',
        httpStatus: 404,
        errorCode: null,
        message: null,
        durationMs: 1,
      })
      return { kind: 'not_found' }
    },
    async register({ domainName }) {
      return domainName === taken
        ? { kind: 'rejected', code: 'DOMAIN_TAKEN', message: 'Domain exists' }
        : { kind: 'ok', data: REGISTERED }
    },
    async setNameservers(_name, nameservers) {
      return { kind: 'ok', data: nameservers }
    },
  })

  /** A worker that claims only this suite's jobs — the queue is shared. */
  function workerFor(jobIds: string[]) {
    const queue = [...jobIds]
    return createWorker({
      store: {
        ...store,
        claim: (worker, testMode, lease) => {
          const next = queue.shift()
          return next ? store.claim(worker, testMode, lease, next) : Promise.resolve(null)
        },
      },
      registrarFor,
      testMode: true,
      workerId: 'db-test',
      pollMs: 1_000,
      log: { info() {}, warn() {}, error() {} },
    })
  }

  async function jobsFor(kind: 'register_domain' | 'apply_nameservers') {
    const { data } = await db
      .from('jobs')
      .select('id, status, domain_id, attempts, domains!inner(domain_name, user_id)')
      .eq('kind', kind)
      .eq('domains.user_id', userId)
      .order('created_at')
    return data ?? []
  }

  beforeAll(async () => {
    const env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    store = createSupabaseStore(db)

    const { data: user, error } = await db.auth.admin.createUser({
      email: `e2e-gateway-${stamp}@example.com`,
      password: `e2e-${stamp}-Pw-9`,
      email_confirm: true,
    })
    if (error) throw error
    userId = user.user.id

    const { data: rate } = await db.from('fx_rates').select('id').limit(1).single()
    const { data: order, error: orderError } = await db
      .from('orders')
      .insert({
        user_id: userId,
        subtotal_kobo: 3_000_000,
        vat_pct: 7.5,
        vat_kobo: 225_000,
        total_kobo: 3_225_000,
        fx_rate_id: rate?.id ?? '',
        tx_ref: `e2e-gw-${stamp}`,
        registrant: REGISTRANT,
        nameservers: VERCEL,
        float_check: 'covered',
        test_mode: true,
      })
      .select('id')
      .single()
    if (orderError) throw orderError
    orderId = order.id

    const line = {
      order_id: orderId,
      tld: 'com',
      period_years: 1,
      privacy: false,
      auto_renew: true,
    }
    await db.from('order_items').insert([
      { ...line, domain: good, price_kobo: 1_500_000, renewal_kobo: 1_500_000 },
      { ...line, domain: taken, price_kobo: 1_500_000, renewal_kobo: 1_500_000 },
    ])
  })

  afterAll(async () => {
    if (!db || !userId) return
    const { data: domains } = await db.from('domains').select('id').eq('user_id', userId)
    const ids = (domains ?? []).map((row) => row.id)
    if (ids.length) {
      const { data: jobs } = await db.from('jobs').select('id').in('domain_id', ids)
      const jobIds = (jobs ?? []).map((row) => row.id)
      if (jobIds.length) await db.from('supplier_calls').delete().in('job_id', jobIds)
      await db.from('domains').delete().in('id', ids)
    }
    await db.from('payments').delete().eq('user_id', userId)
    await db.from('orders').delete().eq('user_id', userId)
    await db.auth.admin.deleteUser(userId)
  })

  it('enqueues one registration per paid line, once (I4)', async () => {
    const pay = () =>
      db.rpc('record_order_payment', {
        p_order_id: orderId,
        p_provider_reference: `e2e-gw-${stamp}`,
        p_amount_kobo: 3_225_000,
        p_currency: 'NGN',
        p_method: 'card',
        p_raw: {},
      })
    expect((await pay()).data).toBe('paid')
    await pay()

    const jobs = await jobsFor('register_domain')
    expect(jobs.map((job) => job.status)).toEqual(['queued', 'queued'])
  })

  it('registers one line and fails the other; the order is partly failed (FR-R2)', async () => {
    const jobs = await jobsFor('register_domain')
    const worker = workerFor(jobs.map((job) => job.id))
    expect(await worker.tick()).toBe(true)
    expect(await worker.tick()).toBe(true)

    const { data: domains } = await db
      .from('domains')
      .select(
        'domain_name, local_status, expires_at, nameservers, pending_nameservers, delegation_status',
      )
      .eq('user_id', userId)
    const byName = new Map((domains ?? []).map((row) => [row.domain_name, row]))
    expect(byName.get(good)).toMatchObject({
      local_status: 'active',
      expires_at: '2027-09-23T10:00:00+00:00',
      nameservers: VERCEL,
      pending_nameservers: null,
      delegation_status: 'pending',
    })
    expect(byName.get(taken)).toMatchObject({ local_status: 'registration_failed' })

    const { data: items } = await db
      .from('order_items')
      .select('domain, status, failure_code')
      .eq('order_id', orderId)
    expect(items).toEqual(
      expect.arrayContaining([
        { domain: good, status: 'completed', failure_code: null },
        { domain: taken, status: 'failed', failure_code: 'DOMAIN_TAKEN' },
      ]),
    )

    const { data: order } = await db.from('orders').select('status').eq('id', orderId).single()
    expect(order?.status).toBe('partially_failed')
  })

  it('records every supplier call against its job (I7)', async () => {
    const jobs = await jobsFor('register_domain')
    const { count } = await db
      .from('supplier_calls')
      .select('id', { count: 'exact', head: true })
      .in(
        'job_id',
        jobs.map((job) => job.id),
      )
    expect(count).toBe(2)
  })

  it('logs what happened on each domain', async () => {
    const { data } = await db
      .from('domain_events')
      .select('event_type, domains!inner(domain_name, user_id)')
      .eq('domains.user_id', userId)
    const types = (data ?? []).map((row) => `${row.domains.domain_name}:${row.event_type}`)
    expect(types).toEqual(
      expect.arrayContaining([
        `${good}:order_paid`,
        `${good}:registered`,
        `${good}:nameservers_applied`,
        `${taken}:registration_failed`,
      ]),
    )
  })

  it('applies a later nameserver change, and only once while one is open', async () => {
    const { data: domain } = await db
      .from('domains')
      .update({ pending_nameservers: NETLIFY })
      .eq('domain_name', good)
      .eq('user_id', userId)
      .select('id')
      .single()
    await db.rpc('enqueue_nameserver_change', { p_domain_id: domain?.id ?? '' })
    await db.rpc('enqueue_nameserver_change', { p_domain_id: domain?.id ?? '' })

    const changes = await jobsFor('apply_nameservers')
    expect(changes).toHaveLength(1)

    await workerFor(changes.map((job) => job.id)).tick()
    const { data: after } = await db
      .from('domains')
      .select('nameservers, pending_nameservers')
      .eq('id', domain?.id ?? '')
      .single()
    expect(after).toEqual({ nameservers: NETLIFY, pending_nameservers: null })
  })

  it('never queues a change for a domain that did not register', async () => {
    const { data: failed } = await db
      .from('domains')
      .update({ pending_nameservers: VERCEL })
      .eq('domain_name', taken)
      .eq('user_id', userId)
      .select('id')
      .single()
    await db.rpc('enqueue_nameserver_change', { p_domain_id: failed?.id ?? '' })
    const { count } = await db
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('domain_id', failed?.id ?? '')
      .eq('kind', 'apply_nameservers')
    expect(count).toBe(0)
  })

  it('is closed to everything but our server', async () => {
    const env = readEnv()
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const claim = await anon.rpc('claim_job', { p_worker: 'x', p_test_mode: true })
    expect(claim.error).not.toBeNull()
    const read = await anon.from('jobs').select('id').limit(1)
    expect(read.data ?? []).toEqual([])
  })
})
