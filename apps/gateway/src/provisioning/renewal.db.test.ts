import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Renewals in the database (migration 23), run for real against test-mode
 * rows: a paid renewal line queues a renewal of the account's own domain —
 * never a new domain — records the registry's new expiry, and a failed one
 * is refunded as a renewal. A line naming someone else's domain is never
 * renewed.
 *
 * Needs the hosted project, so it runs only with DB_TESTS=1:
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/provisioning/renewal.db.test.ts
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

describe.skipIf(!enabled)('renewals against the database', { timeout: 60_000 }, () => {
  let db: SupabaseClient<Database>
  let rateId = ''
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const users: string[] = []

  async function makeUser(label: string) {
    const { data, error } = await db.auth.admin.createUser({
      email: `e2e-renew-${label}-${stamp}@example.com`,
      password: `e2e-${stamp}-Pw-9`,
      email_confirm: true,
    })
    if (error) throw error
    users.push(data.user.id)
    return data.user.id
  }

  async function makeDomain(userId: string, name: string) {
    const { data, error } = await db
      .from('domains')
      .insert({
        user_id: userId,
        domain_name: name,
        tld: 'com',
        source: 'registration',
        test_mode: true,
        local_status: 'active',
        registered_at: '2025-09-23T10:00:00Z',
        expires_at: '2027-09-23T10:00:00Z',
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id
  }

  /** A renewal order: one line, `years` at ₦18,600 a year, VAT 7.5%. */
  async function renewalOrder(userId: string, domainId: string, name: string, years: number) {
    const price = 1_860_000 * years
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
        tx_ref: `MDH-e2e-renew-${name}-${years}-${Date.now()}`,
        registrant: {},
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
        item_type: 'renew',
        domain_id: domainId,
        domain: name,
        tld: 'com',
        period_years: years,
        privacy: false,
        auto_renew: true,
        price_kobo: price,
        renewal_kobo: 1_860_000,
      })
      .select('id')
      .single()
    if (lineError) throw lineError
    return { orderId: order.id, lineId: line.id, total: Number(order.total_kobo) }
  }

  const pay = (orderId: string, reference: string, amount: number) =>
    db.rpc('record_order_payment', {
      p_order_id: orderId,
      p_provider_reference: reference,
      p_amount_kobo: amount,
      p_currency: 'NGN',
      p_method: 'card',
      p_raw: { id: reference, flw_ref: `FLW-${reference}`, status: 'successful' },
    })

  const jobFor = async (lineId: string) => {
    const { data } = await db
      .from('jobs')
      .select('id, kind, status, domain_id')
      .eq('order_item_id', lineId)
      .maybeSingle()
    return data
  }

  beforeAll(async () => {
    const env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: rate } = await db.from('fx_rates').select('id').limit(1).single()
    rateId = rate?.id ?? ''
  })

  afterAll(async () => {
    if (!db) return
    for (const userId of users) {
      await db.rpc('purge_test_orders', { p_user_id: userId })
      await db.from('domains').delete().eq('user_id', userId)
      await db.auth.admin.deleteUser(userId)
    }
  }, 120_000)

  it('renews the account’s own domain: a job, no new domain, and the new expiry recorded', async () => {
    const userId = await makeUser('own')
    const name = `e2ecartrenew${stamp}a.com`
    const domainId = await makeDomain(userId, name)
    const { orderId, lineId, total } = await renewalOrder(userId, domainId, name, 2)

    const paid = await pay(orderId, `e2e-renew-a-${stamp}`, total)
    expect(paid.error?.message ?? null).toBeNull()
    expect(paid.data).toBe('paid')
    const job = await jobFor(lineId)
    expect(job).toMatchObject({ kind: 'renew_domain', status: 'queued', domain_id: domainId })
    const { count } = await db
      .from('domains')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
    expect(count).toBe(1)

    const { data: claimed } = await db.rpc('claim_job', {
      p_worker: 'db-test',
      p_test_mode: true,
      p_lease_seconds: 300,
      p_job_id: job?.id ?? '',
    })
    expect(claimed).toMatchObject({
      kind: 'renew_domain',
      period_years: 2,
      baseline_expiry: null,
      payment: { reference: `e2e-renew-a-${stamp}`, status: 'successful', currency: 'NGN' },
    })

    // The baseline is kept from the first call; a later one cannot move it.
    const first = await db.rpc('note_renewal_baseline', {
      p_job_id: job?.id ?? '',
      p_expires_at: '2027-09-23T10:00:00Z',
    })
    const second = await db.rpc('note_renewal_baseline', {
      p_job_id: job?.id ?? '',
      p_expires_at: '2030-01-01T00:00:00Z',
    })
    expect(Date.parse(String(first.data))).toBe(Date.parse('2027-09-23T10:00:00Z'))
    expect(Date.parse(String(second.data))).toBe(Date.parse('2027-09-23T10:00:00Z'))

    expect(
      (
        await db.rpc('complete_renewal', {
          p_job_id: job?.id ?? '',
          p_expires_at: '2029-09-23T10:00:00Z',
          p_recovered: false,
        })
      ).error,
    ).toBeNull()

    const { data: domain } = await db
      .from('domains')
      .select('expires_at, local_status')
      .eq('id', domainId)
      .single()
    expect(Date.parse(domain?.expires_at ?? '')).toBe(Date.parse('2029-09-23T10:00:00Z'))
    expect(domain?.local_status).toBe('active')
    const { data: order } = await db.from('orders').select('status').eq('id', orderId).single()
    expect(order?.status).toBe('completed')
    const { data: events } = await db
      .from('domain_events')
      .select('event_type')
      .eq('domain_id', domainId)
      .order('created_at')
    expect(events?.map((event) => event.event_type)).toEqual(['renewal_paid', 'renewed'])
  })

  it('refunds a failed renewal as a renewal, and leaves the domain as it was', async () => {
    const userId = await makeUser('fail')
    const name = `e2ecartrenew${stamp}b.com`
    const domainId = await makeDomain(userId, name)
    const { orderId, lineId, total } = await renewalOrder(userId, domainId, name, 1)
    await pay(orderId, `e2e-renew-b-${stamp}`, total)
    const job = await jobFor(lineId)
    await db.rpc('claim_job', {
      p_worker: 'db-test',
      p_test_mode: true,
      p_lease_seconds: 300,
      p_job_id: job?.id ?? '',
    })
    expect(
      (
        await db.rpc('fail_job', {
          p_job_id: job?.id ?? '',
          p_code: 'DOMAIN_NOT_FOUND',
          p_message: 'Not in our account',
          p_needs_attention: false,
        })
      ).error,
    ).toBeNull()

    const { data: refund } = await db
      .from('refunds')
      .select('reason, amount_kobo, status')
      .eq('order_item_id', lineId)
      .single()
    expect(refund).toMatchObject({ reason: 'renewal_failed', status: 'queued' })
    expect(Number(refund?.amount_kobo)).toBe(total)
    const { data: domain } = await db
      .from('domains')
      .select('expires_at, local_status')
      .eq('id', domainId)
      .single()
    expect(domain?.local_status).toBe('active')
    expect(Date.parse(domain?.expires_at ?? '')).toBe(Date.parse('2027-09-23T10:00:00Z'))
  })

  it('never renews someone else’s domain: the line fails and is refunded', async () => {
    const owner = await makeUser('owner')
    const other = await makeUser('other')
    const name = `e2ecartrenew${stamp}c.com`
    const domainId = await makeDomain(owner, name)
    const { orderId, lineId, total } = await renewalOrder(other, domainId, name, 1)

    await pay(orderId, `e2e-renew-c-${stamp}`, total)
    expect(await jobFor(lineId)).toBeNull()
    const { data: line } = await db
      .from('order_items')
      .select('status, failure_code')
      .eq('id', lineId)
      .single()
    expect(line).toEqual({ status: 'failed', failure_code: 'NOT_RENEWABLE' })
    const { data: refund } = await db
      .from('refunds')
      .select('reason, amount_kobo')
      .eq('order_item_id', lineId)
      .single()
    expect(refund).toMatchObject({ reason: 'renewal_failed' })
    expect(Number(refund?.amount_kobo)).toBe(total)
  })

  it('refuses a renewal line that names no domain', async () => {
    const userId = await makeUser('bare')
    const { data: order } = await db
      .from('orders')
      .insert({
        user_id: userId,
        subtotal_kobo: 1_860_000,
        vat_pct: 7.5,
        vat_kobo: 139_500,
        total_kobo: 1_999_500,
        fx_rate_id: rateId,
        tx_ref: `MDH-e2e-renew-bare-${stamp}`,
        registrant: {},
        float_check: 'covered',
        test_mode: true,
      })
      .select('id')
      .single()
    const { error } = await db.from('order_items').insert({
      order_id: order?.id ?? '',
      item_type: 'renew',
      domain: 'nothing.com',
      tld: 'com',
      period_years: 1,
      privacy: false,
      auto_renew: true,
      price_kobo: 1_860_000,
      renewal_kobo: 1_860_000,
    })
    expect(error?.message).toMatch(/order_items_renewal_names_domain/)
  })
})
