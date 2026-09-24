import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Lookup, Registrar, TransferRegistrar } from './registrar'
import { type ClaimedJob, createSupabaseStore, type JobStore } from './store'
import { createWorker } from './worker'

/**
 * Transfers in against the database (migration 26), run for real on
 * test-mode rows with the real worker and store — only the registry is
 * faked. A paid transfer line becomes a domain and a job; the code is handed
 * to the worker until the registry has the request and is then deleted; the
 * domain becomes active when the registry shows it. A refused transfer is
 * refunded as a transfer, loses its code, and cannot be retried.
 *
 * Needs the hosted project, so it runs only with DB_TESTS=1:
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/provisioning/transfer.db.test.ts
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
const CODE = 'e2e-Transfer-Code-9'
const ACTIVE: Lookup = {
  kind: 'found',
  domain: {
    registeredAt: '2019-03-01T10:00:00.000Z',
    expiresAt: '2027-03-01T10:00:00.000Z',
    nameservers: ['ns1.example-host.com', 'ns2.example-host.com'],
    transferLock: true,
    privacy: false,
    status: 'Active',
  },
}

describe.skipIf(!enabled)('transfers in against the database', { timeout: 60_000 }, () => {
  let db: SupabaseClient<Database>
  let store: JobStore
  let userId = ''
  let rateId = ''
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const codesSeen: (string | null | undefined)[] = []

  /** A registry that says what the test tells it, and remembers the codes it was given. */
  function registry(script: { lookups: Lookup[]; transferable?: boolean }): TransferRegistrar {
    const lookups = [...script.lookups]
    return {
      lookup: async () => lookups.shift() ?? { kind: 'not_found' },
      checkTransfer: async (_name, code) => {
        codesSeen.push(code)
        return script.transferable === false
          ? { kind: 'ok', data: { transferable: false, reason: 'AUTH_CODE_INVALID' } }
          : { kind: 'ok', data: { transferable: true } }
      },
      transfer: async ({ authCode }) => {
        codesSeen.push(authCode)
        return { kind: 'ok' }
      },
    }
  }

  /** A worker that claims only the named job — the queue is shared. */
  function workerFor(jobId: string, transfers: TransferRegistrar) {
    let claimed = false
    return createWorker({
      store: {
        ...store,
        claim: async (worker, testMode, lease) => {
          if (claimed) return null
          claimed = true
          const job = await store.claim(worker, testMode, lease, jobId)
          codesSeen.push(job?.authCode)
          return job
        },
      },
      registrarFor: (): Registrar => {
        throw new Error('a transfer used the registration registrar')
      },
      transfersFor: (_job: ClaimedJob) => transfers,
      checkPayment: async () => ({ kind: 'verified' }),
      testMode: true,
      workerId: 'db-test',
      pollMs: 1_000,
      log: { info() {}, warn() {}, error() {} },
    })
  }

  /** A paid transfer order: one line at ₦42,000 plus VAT, with its code in the vault. */
  async function paidTransfer(label: string) {
    const name = `e2ecartxfer${stamp}${label}.com`
    const price = 4_200_000
    const vat = Math.round(price * 0.075)
    const { data: order, error } = await db
      .from('orders')
      .insert({
        user_id: userId,
        subtotal_kobo: price,
        vat_pct: 7.5,
        vat_kobo: vat,
        total_kobo: price + vat,
        fx_rate_id: rateId,
        tx_ref: `MDH-e2e-xfer-${stamp}-${label}`,
        registrant: REGISTRANT,
        float_check: 'covered',
        test_mode: true,
      })
      .select('id, total_kobo')
      .single()
    if (error) throw error
    const { data: line, error: lineError } = await db
      .from('order_items')
      .insert({
        order_id: order.id,
        item_type: 'transfer',
        domain: name,
        tld: 'com',
        period_years: 1,
        privacy: false,
        auto_renew: true,
        price_kobo: price,
        renewal_kobo: 1_870_000,
      })
      .select('id')
      .single()
    if (lineError) throw lineError
    const { error: secretError } = await db
      .from('transfer_secrets')
      .insert({ order_item_id: line.id, auth_code: CODE })
    if (secretError) throw secretError

    const paid = await db.rpc('record_order_payment', {
      p_order_id: order.id,
      p_provider_reference: `e2e-xfer-${stamp}-${label}`,
      p_amount_kobo: Number(order.total_kobo),
      p_currency: 'NGN',
      p_method: 'card',
      p_raw: { id: label, status: 'successful' },
    })
    expect(paid.error?.message ?? null).toBeNull()
    expect(paid.data).toBe('paid')

    const { data: job } = await db
      .from('jobs')
      .select('id, kind, status, domain_id, submitted_at, run_after')
      .eq('order_item_id', line.id)
      .single()
    return {
      name,
      orderId: order.id,
      lineId: line.id,
      total: Number(order.total_kobo),
      jobId: job?.id ?? '',
      domainId: job?.domain_id ?? '',
      job,
    }
  }

  const secretFor = async (lineId: string) =>
    (await db.from('transfer_secrets').select('order_item_id').eq('order_item_id', lineId)).data ??
    []
  const domainRow = async (domainId: string) =>
    (
      await db
        .from('domains')
        .select('local_status, source, expires_at, nameservers, pending_nameservers, registrant')
        .eq('id', domainId)
        .single()
    ).data
  /** Stands in for the clock reaching the next poll. */
  const pollNow = (jobId: string) =>
    db.from('jobs').update({ run_after: new Date().toISOString() }).eq('id', jobId)

  beforeAll(async () => {
    const env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    store = createSupabaseStore(db)
    const { data: user, error } = await db.auth.admin.createUser({
      email: `e2e-xfer-${stamp}@example.com`,
      password: `e2e-${stamp}-Pw-9`,
      email_confirm: true,
    })
    if (error) throw error
    userId = user.user.id
    const { data: rate } = await db.from('fx_rates').select('id').limit(1).single()
    rateId = rate?.id ?? ''
  })

  afterAll(async () => {
    if (!db || !userId) return
    await db.rpc('purge_test_orders', { p_user_id: userId })
    await db.from('domains').delete().eq('user_id', userId)
    await db.auth.admin.deleteUser(userId)
  }, 120_000)

  it('turns a paid transfer into a waiting domain and a job, keeping its nameservers', async () => {
    const order = await paidTransfer('a')
    expect(order.job).toMatchObject({
      kind: 'transfer_domain',
      status: 'queued',
      submitted_at: null,
    })
    expect(await domainRow(order.domainId)).toMatchObject({
      local_status: 'transfer_requested',
      source: 'transfer',
      expires_at: null,
      pending_nameservers: null,
      registrant: REGISTRANT,
    })
  })

  it('sends with the code, deletes it once submitted, and records the domain when it lands', async () => {
    const order = await paidTransfer('b')
    codesSeen.length = 0

    await workerFor(order.jobId, registry({ lookups: [{ kind: 'not_found' }] })).tick()
    // claim_job handed over the code, and it reached the check and the transfer.
    expect(codesSeen).toEqual([CODE, CODE, CODE])
    expect(await secretFor(order.lineId)).toEqual([])
    expect((await domainRow(order.domainId))?.local_status).toBe('transfer_pending')
    const { data: waiting } = await db
      .from('jobs')
      .select('status, submitted_at, run_after, last_error_code')
      .eq('id', order.jobId)
      .single()
    expect(waiting).toMatchObject({ status: 'queued', last_error_code: 'TRANSFER_PENDING' })
    expect(waiting?.submitted_at).not.toBeNull()
    // The first poll is 15 minutes out (PRD §13.5).
    expect(Date.parse(waiting?.run_after ?? '') - Date.now()).toBeGreaterThan(10 * 60_000)

    codesSeen.length = 0
    await pollNow(order.jobId)
    await workerFor(order.jobId, registry({ lookups: [ACTIVE] })).tick()
    // Polling is handed no code: it was deleted with the submission.
    expect(codesSeen).toEqual([null])

    const domain = await domainRow(order.domainId)
    expect(domain).toMatchObject({
      local_status: 'active',
      nameservers: ['ns1.example-host.com', 'ns2.example-host.com'],
    })
    expect(Date.parse(domain?.expires_at ?? '')).toBe(Date.parse('2027-03-01T10:00:00.000Z'))
    const { data: line } = await db
      .from('order_items')
      .select('status')
      .eq('id', order.lineId)
      .single()
    expect(line?.status).toBe('completed')
    const { data: settled } = await db
      .from('orders')
      .select('status')
      .eq('id', order.orderId)
      .single()
    expect(settled?.status).toBe('completed')
    const { data: events } = await db
      .from('domain_events')
      .select('event_type')
      .eq('domain_id', order.domainId)
      .order('created_at')
    expect(events?.map((event) => event.event_type)).toEqual([
      'order_paid',
      'transfer_submitted',
      'transferred_in',
    ])
  })

  it('refunds a refused code as a transfer, deletes the code, and refuses a retry', async () => {
    const order = await paidTransfer('c')
    await workerFor(order.jobId, registry({ lookups: [], transferable: false })).tick()

    const { data: line } = await db
      .from('order_items')
      .select('status, failure_code')
      .eq('id', order.lineId)
      .single()
    expect(line).toEqual({ status: 'failed', failure_code: 'AUTH_CODE_INVALID' })
    expect((await domainRow(order.domainId))?.local_status).toBe('transfer_cancelled')
    expect(await secretFor(order.lineId)).toEqual([])
    const { data: refund } = await db
      .from('refunds')
      .select('reason, amount_kobo, status')
      .eq('order_item_id', order.lineId)
      .single()
    expect(refund).toMatchObject({ reason: 'transfer_failed', status: 'queued' })
    expect(Number(refund?.amount_kobo)).toBe(order.total)

    const retried = await db.rpc('retry_job', { p_job_id: order.jobId })
    expect(retried.error?.message).toMatch(/cannot be retried/)
  })

  it('marks a transfer refused after submission as rejected, and refunds it', async () => {
    const order = await paidTransfer('d')
    await workerFor(order.jobId, registry({ lookups: [{ kind: 'not_found' }] })).tick()
    await pollNow(order.jobId)
    await workerFor(
      order.jobId,
      registry({
        lookups: [
          { ...ACTIVE, domain: { ...ACTIVE.domain, status: 'TransferCancelled' } } as Lookup,
        ],
      }),
    ).tick()

    expect((await domainRow(order.domainId))?.local_status).toBe('transfer_rejected')
    const { data: refund } = await db
      .from('refunds')
      .select('reason')
      .eq('order_item_id', order.lineId)
      .single()
    expect(refund?.reason).toBe('transfer_failed')
    const { data: settled } = await db
      .from('orders')
      .select('status')
      .eq('id', order.orderId)
      .single()
    expect(settled?.status).toBe('failed')
  })

  it('never lets anyone but the service read a transfer code', async () => {
    const env = readEnv()
    const anon = createClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { data, error } = await anon.from('transfer_secrets').select('auth_code').limit(1)
    expect(data ?? []).toEqual([])
    expect(error).not.toBeNull()
  })
})
