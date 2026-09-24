import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asRegistryContact,
  type Lookup,
  type Reading,
  type RegistryContacts,
  type RegistryDomain,
  type SettingsRegistrar,
  type SettingWrite,
} from './registrar'
import { createSupabaseStore, type JobStore } from './store'
import { createWorker } from './worker'

/**
 * Registry-side settings (migration 26) against the database: the web app's
 * request (a pending value, then enqueue_domain_change), the worker's answer
 * (record_domain_change, fail_job), and what the domain and its activity
 * show afterwards. Only the registry is faked.
 *
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/provisioning/settings.db.test.ts
 *
 * Sandbox (test-mode) rows only, on its own e2e-* user, removed afterwards.
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

const ADA = {
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
const BAYO = { ...ADA, firstName: 'Bayo', email: 'bayo@example.com' }

const HELD: RegistryDomain = {
  registeredAt: '2026-09-23T10:00:00.000Z',
  expiresAt: '2027-09-23T10:00:00.000Z',
  nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
  transferLock: true,
  privacy: false,
}

type Kind = 'set_transfer_lock' | 'set_privacy' | 'update_contacts'

describe.skipIf(!enabled)('registry-side settings against the database', () => {
  let db: SupabaseClient<Database>
  let store: JobStore
  let userId = ''
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const ids: Record<'active' | 'demo' | 'pending', string> = { active: '', demo: '', pending: '' }

  /** The registry the fake answers with: flips when a write is made. */
  let registry = { ...HELD }
  let contacts: RegistryContacts = {}
  let refuse: SettingWrite | null = null

  const settings: SettingsRegistrar = {
    async lookup(): Promise<Lookup> {
      return { kind: 'found', domain: registry }
    },
    async contacts(): Promise<Reading<RegistryContacts>> {
      return { kind: 'found', data: contacts }
    },
    async setTransferLock(_name, locked) {
      if (refuse) return refuse
      registry = { ...registry, transferLock: locked }
      return { kind: 'ok' }
    },
    async setPrivacy(_name, enabled) {
      if (refuse) return refuse
      registry = { ...registry, privacy: enabled }
      return { kind: 'ok' }
    },
    async updateContacts(_name, contact) {
      if (refuse) return refuse
      const held = asRegistryContact(contact)
      contacts = { registrant: held, administrative: held, technical: held, billing: held }
      return { kind: 'ok' }
    },
  }

  /** A worker that claims only the given jobs — the queue is shared. */
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
      registrarFor: () => {
        throw new Error('settings jobs use the settings registrar')
      },
      settingsFor: () => settings,
      checkPayment: async () => ({ kind: 'verified' }),
      testMode: true,
      workerId: 'db-test-settings',
      pollMs: 1_000,
      log: { info() {}, warn() {}, error() {} },
    })
  }

  async function openJobs(domainId: string, kind: Kind) {
    const { data } = await db
      .from('jobs')
      .select('id, status, last_error_code')
      .eq('domain_id', domainId)
      .eq('kind', kind)
      .order('created_at')
    return data ?? []
  }

  async function domain(id: string) {
    const { data } = await db
      .from('domains')
      .select(
        'transfer_lock, privacy_enabled, registrant, pending_transfer_lock, pending_privacy, pending_registrant',
      )
      .eq('id', id)
      .single()
    return data
  }

  async function events(id: string) {
    const { data } = await db
      .from('domain_events')
      .select('event_type, payload')
      .eq('domain_id', id)
      .order('created_at')
    return data ?? []
  }

  /** What the web app does: record the request, then queue it. */
  async function ask(
    id: string,
    kind: Kind,
    patch: Database['public']['Tables']['domains']['Update'],
  ) {
    const { error } = await db.from('domains').update(patch).eq('id', id)
    if (error) throw error
    const queued = await db.rpc('enqueue_domain_change', { p_domain_id: id, p_kind: kind })
    if (queued.error) throw queued.error
  }

  beforeAll(async () => {
    const env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    store = createSupabaseStore(db)

    const { data: user, error } = await db.auth.admin.createUser({
      email: `e2e-settings-${stamp}@example.com`,
      password: `e2e-${stamp}-Pw-9`,
      email_confirm: true,
    })
    if (error) throw error
    userId = user.user.id

    const row = {
      user_id: userId,
      tld: 'com',
      test_mode: true,
      registered_at: '2026-01-01T00:00:00Z',
      expires_at: '2027-01-01T00:00:00Z',
      transfer_lock: true,
      privacy_enabled: false,
      registrant: ADA,
    }
    const { data, error: insertError } = await db
      .from('domains')
      .insert([
        {
          ...row,
          domain_name: `e2ecartset${stamp}a.com`,
          source: 'registration',
          local_status: 'active',
        },
        { ...row, domain_name: `e2ecartset${stamp}b.com`, source: 'demo', local_status: 'active' },
        {
          ...row,
          domain_name: `e2ecartset${stamp}c.com`,
          source: 'registration',
          local_status: 'pending',
        },
      ])
      .select('id, domain_name')
    if (insertError) throw insertError
    for (const inserted of data ?? []) {
      if (inserted.domain_name.endsWith('a.com')) ids.active = inserted.id
      if (inserted.domain_name.endsWith('b.com')) ids.demo = inserted.id
      if (inserted.domain_name.endsWith('c.com')) ids.pending = inserted.id
    }
  })

  afterAll(async () => {
    if (!db || !userId) return
    const { data: domains } = await db.from('domains').select('id').eq('user_id', userId)
    const domainIds = (domains ?? []).map((row) => row.id)
    if (domainIds.length) {
      const { data: jobs } = await db.from('jobs').select('id').in('domain_id', domainIds)
      const jobIds = (jobs ?? []).map((row) => row.id)
      if (jobIds.length) await db.from('supplier_calls').delete().in('job_id', jobIds)
      await db.from('domains').delete().in('id', domainIds)
    }
    await db.auth.admin.deleteUser(userId)
  })

  it('queues nothing for a demo domain, one still registering, or nothing asked for', async () => {
    await ask(ids.demo, 'set_transfer_lock', { pending_transfer_lock: false })
    await ask(ids.pending, 'set_transfer_lock', { pending_transfer_lock: false })
    await ask(ids.active, 'set_transfer_lock', {})
    expect(await openJobs(ids.demo, 'set_transfer_lock')).toEqual([])
    expect(await openJobs(ids.pending, 'set_transfer_lock')).toEqual([])
    expect(await openJobs(ids.active, 'set_transfer_lock')).toEqual([])
  })

  it('refuses a kind that is not a setting', async () => {
    const { error } = await db.rpc('enqueue_domain_change', {
      p_domain_id: ids.active,
      p_kind: 'renew_domain',
    })
    expect(error?.message).toMatch(/not a domain setting/)
  })

  it('queues one job per setting while one is open', async () => {
    await ask(ids.active, 'set_transfer_lock', { pending_transfer_lock: false })
    await ask(ids.active, 'set_transfer_lock', { pending_transfer_lock: false })
    const jobs = await openJobs(ids.active, 'set_transfer_lock')
    expect(jobs.map((job) => job.status)).toEqual(['queued'])
  })

  it('hands the worker what was asked and what the domain holds', async () => {
    const [job] = await openJobs(ids.active, 'set_transfer_lock')
    const claimed = await store.claim('db-test-settings', true, 300, job?.id)
    expect(claimed).toMatchObject({
      kind: 'set_transfer_lock',
      source: 'registration',
      localStatus: 'active',
      pendingTransferLock: false,
      pendingPrivacy: null,
      pendingRegistrant: null,
    })
    // Put it back as the worker would after a timeout, to be worked below.
    await store.reschedule(job?.id ?? '', 0, 'TIMEOUT', 'db test')
  })

  it('turns the lock off at the registry and records what it holds', async () => {
    const jobs = await openJobs(ids.active, 'set_transfer_lock')
    expect(await workerFor(jobs.map((job) => job.id)).tick()).toBe(true)

    expect(await domain(ids.active)).toMatchObject({
      transfer_lock: false,
      pending_transfer_lock: null,
    })
    expect(registry.transferLock).toBe(false)
    expect((await openJobs(ids.active, 'set_transfer_lock')).map((job) => job.status)).toEqual([
      'succeeded',
    ])
    expect(await events(ids.active)).toContainEqual({
      event_type: 'transfer_lock_applied',
      payload: { transfer_lock: false },
    })
  })

  it('sends the newer value when the customer asked again while a change ran', async () => {
    await ask(ids.active, 'set_transfer_lock', { pending_transfer_lock: true })
    const [, queued] = await openJobs(ids.active, 'set_transfer_lock')
    await store.claim('db-test-settings', true, 300, queued?.id)
    // They change their mind before the registry answers.
    await db.from('domains').update({ pending_transfer_lock: false }).eq('id', ids.active)
    await store.recordDomainChange(
      queued?.id ?? '',
      { transfer_lock: true },
      { transfer_lock: true },
      null,
    )
    registry = { ...registry, transferLock: true }

    expect(await domain(ids.active)).toMatchObject({
      transfer_lock: true,
      pending_transfer_lock: false,
    })
    const jobs = await openJobs(ids.active, 'set_transfer_lock')
    expect(jobs.map((job) => job.status)).toEqual(['succeeded', 'succeeded', 'queued'])

    await workerFor([jobs[2]?.id ?? '']).tick()
    expect(await domain(ids.active)).toMatchObject({
      transfer_lock: false,
      pending_transfer_lock: null,
    })
  })

  it('records a refusal: the request is dropped and the activity says why', async () => {
    refuse = { kind: 'rejected', code: 'REGISTRY_REFUSED', message: 'Not allowed' }
    try {
      await ask(ids.active, 'set_privacy', { pending_privacy: true })
      const jobs = await openJobs(ids.active, 'set_privacy')
      await workerFor(jobs.map((job) => job.id)).tick()
    } finally {
      refuse = null
    }
    expect(await domain(ids.active)).toMatchObject({
      privacy_enabled: false,
      pending_privacy: null,
    })
    expect((await openJobs(ids.active, 'set_privacy'))[0]).toMatchObject({
      status: 'failed',
      last_error_code: 'REGISTRY_REFUSED',
    })
    expect(await events(ids.active)).toContainEqual({
      event_type: 'privacy_rejected',
      payload: { code: 'REGISTRY_REFUSED' },
    })
  })

  it('updates the registrant and keeps the details out of the activity log (N13)', async () => {
    contacts = {
      registrant: asRegistryContact(ADA),
      administrative: asRegistryContact(ADA),
    }
    await ask(ids.active, 'update_contacts', { pending_registrant: BAYO })
    const jobs = await openJobs(ids.active, 'update_contacts')
    await workerFor(jobs.map((job) => job.id)).tick()

    expect(await domain(ids.active)).toMatchObject({
      registrant: BAYO,
      pending_registrant: null,
    })
    const applied = (await events(ids.active)).filter(
      (event) => event.event_type === 'contacts_applied',
    )
    expect(applied).toEqual([{ event_type: 'contacts_applied', payload: {} }])
    expect(JSON.stringify(await events(ids.active))).not.toContain('bayo@example.com')
  })

  it('keeps a change a person must look at, and drops one given up on', async () => {
    await ask(ids.active, 'update_contacts', { pending_registrant: ADA })
    const [, held] = await openJobs(ids.active, 'update_contacts')
    await store.claim('db-test-settings', true, 300, held?.id)
    await store.fail(held?.id ?? '', 'TIMEOUT', 'db test', true)
    expect(await domain(ids.active)).toMatchObject({ pending_registrant: ADA })

    await store.fail(held?.id ?? '', 'SUPPLIER_UNAVAILABLE', 'db test', false)
    expect(await domain(ids.active)).toMatchObject({ pending_registrant: null })
    const types = (await events(ids.active)).map((event) => event.event_type)
    expect(types).toEqual(expect.arrayContaining(['contacts_delayed', 'contacts_not_applied']))
  })

  it('is closed to everything but our server', async () => {
    const env = readEnv()
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const queued = await anon.rpc('enqueue_domain_change', {
      p_domain_id: ids.active,
      p_kind: 'set_transfer_lock',
    })
    expect(queued.error).not.toBeNull()
    const recorded = await anon.rpc('record_domain_change', {
      p_job_id: ids.active,
      p_attempted: {},
      p_applied: {},
    })
    expect(recorded.error).not.toBeNull()
  })
})
