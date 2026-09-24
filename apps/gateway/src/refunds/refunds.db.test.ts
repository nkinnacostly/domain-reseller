import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toDueAlerts } from '../alerts/store'
import { toClaimedRefund } from './store'

/**
 * The refund and alert functions (migrations 15–19), run for real against
 * test-mode orders: what a failed line, a second charge, an overpayment and an
 * underpayment each owe; that the service key cannot write money rows or
 * approve its own refunds; the customer's view; alerts; rate limits.
 *
 * Needs the hosted project, so it runs only with DB_TESTS=1:
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/refunds/refunds.db.test.ts
 * Every row it makes is test-mode and belongs to its own e2e-* users.
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

// Each test makes many round trips to the hosted project.
describe.skipIf(!enabled)('refunds and alerts against the database', { timeout: 60_000 }, () => {
  let db: SupabaseClient<Database>
  let env: Record<string, string>
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const password = `e2e-${stamp}-Pw-9`
  const users: string[] = []
  let rateId = ''

  async function makeUser(label: string) {
    const { data, error } = await db.auth.admin.createUser({
      email: `e2e-refunds-${label}-${stamp}@example.com`,
      password,
      email_confirm: true,
    })
    if (error) throw error
    users.push(data.user.id)
    return { id: data.user.id, email: data.user.email ?? '' }
  }

  /** An order with lines at these prices; VAT at 7.5% of the subtotal, rounded. */
  async function makeOrder(userId: string, prices: number[], tag: string) {
    const subtotal = prices.reduce((sum, price) => sum + price, 0)
    const vat = Math.round(subtotal * 0.075)
    const { data: order, error } = await db
      .from('orders')
      .insert({
        user_id: userId,
        subtotal_kobo: subtotal,
        vat_pct: 7.5,
        vat_kobo: vat,
        total_kobo: subtotal + vat,
        fx_rate_id: rateId,
        tx_ref: `MDH-e2e-${tag}-${stamp}`,
        registrant: REGISTRANT,
        float_check: 'covered',
        test_mode: true,
      })
      .select('id, total_kobo, vat_kobo, subtotal_kobo')
      .single()
    if (error) throw error
    const { error: linesError } = await db.from('order_items').insert(
      prices.map((price, index) => ({
        order_id: order.id,
        domain: `e2erefund${stamp}${tag}${index}.com`,
        tld: 'com',
        period_years: 1,
        privacy: false,
        auto_renew: true,
        price_kobo: price,
        renewal_kobo: price,
      })),
    )
    if (linesError) throw linesError
    return { id: order.id, total: Number(order.total_kobo), vat, subtotal }
  }

  const pay = (orderId: string, reference: string, amountKobo: number) =>
    db.rpc('record_order_payment', {
      p_order_id: orderId,
      p_provider_reference: reference,
      p_amount_kobo: amountKobo,
      p_currency: 'NGN',
      p_method: 'card',
      p_raw: { id: reference, flw_ref: `FLW-${reference}`, status: 'successful' },
    })

  async function refundsFor(orderId: string) {
    const { data, error } = await db
      .from('refunds')
      .select('id, reason, amount_kobo, status, run_after, order_item_id, payment_id')
      .eq('order_id', orderId)
      .order('created_at')
    if (error) throw error
    return data ?? []
  }

  /** Fails every register job of an order, as the worker does on a refusal. */
  async function failLines(orderId: string) {
    const { data: jobs } = await db
      .from('jobs')
      .select('id, order_items!inner(order_id)')
      .eq('order_items.order_id', orderId)
    for (const job of jobs ?? []) {
      await db.rpc('claim_job', {
        p_worker: 'db-test',
        p_test_mode: true,
        p_lease_seconds: 300,
        p_job_id: job.id,
      })
      const { error } = await db.rpc('fail_job', {
        p_job_id: job.id,
        p_code: 'DOMAIN_TAKEN',
        p_message: 'Domain exists',
        p_needs_attention: false,
      })
      if (error) throw error
    }
  }

  /**
   * Claims this refund. The test side's queue is shared, so anything else due
   * is put back an hour later (test-mode rows only) — never sent.
   */
  async function claimOurs(refundId: string) {
    for (let i = 0; i < 20; i += 1) {
      const { data, error } = await db.rpc('claim_refund', {
        p_worker: 'db-test',
        p_test_mode: true,
        p_lease_seconds: 300,
      })
      if (error) throw error
      if (!data) return null
      const claimed = toClaimedRefund(data)
      if (claimed.id === refundId) return claimed
      await db.rpc('reschedule_refund', {
        p_refund_id: claimed.id,
        p_worker: 'db-test',
        p_delay_seconds: 3600,
        p_code: 'DB_TEST_SKIPPED',
        p_message: 'Left for its own test',
        p_sent: claimed.action !== 'send' || claimed.providerCalledAt !== null,
      })
    }
    return null
  }

  beforeAll(async () => {
    env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: rate } = await db.from('fx_rates').select('id').limit(1).single()
    rateId = rate?.id ?? ''
  })

  afterAll(async () => {
    if (!db) return
    for (const userId of users) {
      await db.from('domains').delete().eq('user_id', userId)
      await db.rpc('purge_test_orders', { p_user_id: userId })
      await db.auth.admin.deleteUser(userId)
    }
  }, 120_000)

  it('refunds each failed line its price and VAT share, adding up to exactly what was paid', async () => {
    const user = await makeUser('lines')
    // Odd kobo on purpose: the order's VAT does not split evenly.
    const order = await makeOrder(user.id, [1_830_050, 2_190_033, 999_999], 'lines')
    expect((await pay(order.id, `e2e-lines-${stamp}`, order.total)).data).toBe('paid')

    const { data: paid } = await db.from('orders').select('payment_id').eq('id', order.id).single()
    expect(paid?.payment_id).toBeTruthy()

    await failLines(order.id)
    const refunds = await refundsFor(order.id)
    expect(refunds).toHaveLength(3)
    expect(refunds.every((refund) => refund.reason === 'registration_failed')).toBe(true)
    expect(refunds.every((refund) => refund.status === 'queued')).toBe(true)
    expect(refunds.every((refund) => refund.payment_id === paid?.payment_id)).toBe(true)
    // Every naira back, no more.
    expect(refunds.reduce((sum, refund) => sum + Number(refund.amount_kobo), 0)).toBe(order.total)

    // Each within a kobo of its proportional share.
    const { data: lines } = await db
      .from('order_items')
      .select('id, price_kobo, status')
      .eq('order_id', order.id)
    for (const line of lines ?? []) {
      const refund = refunds.find((candidate) => candidate.order_item_id === line.id)
      const share = (order.vat * Number(line.price_kobo)) / order.subtotal
      expect(Math.abs(Number(refund?.amount_kobo) - Number(line.price_kobo) - share)).toBeLessThan(
        1,
      )
      expect(line.status).toBe('failed')
    }

    // Held back a few minutes, for a late registry answer.
    const soonest = Math.min(...refunds.map((refund) => Date.parse(refund.run_after)))
    expect(soonest).toBeGreaterThan(Date.now() + 5 * 60_000)

    // Failing the same job again adds nothing (I6: never twice).
    await failLines(order.id)
    expect(await refundsFor(order.id)).toHaveLength(3)

    const { data: settled } = await db.from('orders').select('status').eq('id', order.id).single()
    expect(settled?.status).toBe('failed')
  })

  it('sends back every kobo of a second charge for a paid order, once', async () => {
    const user = await makeUser('duplicate')
    const order = await makeOrder(user.id, [1_830_000], 'dup')
    await pay(order.id, `e2e-dup-a-${stamp}`, order.total)
    expect((await pay(order.id, `e2e-dup-b-${stamp}`, order.total)).error).toBeNull()
    // The webhook and the redirect both report the second charge.
    await pay(order.id, `e2e-dup-b-${stamp}`, order.total)

    const refunds = await refundsFor(order.id)
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ reason: 'duplicate_charge', status: 'queued' })
    expect(Number(refunds[0]?.amount_kobo)).toBe(order.total)
    expect(Date.parse(refunds[0]?.run_after ?? '')).toBeLessThanOrEqual(Date.now() + 5_000)
  })

  it('refuses a charge that belongs to another order, and one below the total', async () => {
    const user = await makeUser('refuse')
    const first = await makeOrder(user.id, [1_830_000], 'rf1')
    const second = await makeOrder(user.id, [1_830_000], 'rf2')
    await pay(first.id, `e2e-rf-${stamp}`, first.total)
    expect((await pay(second.id, `e2e-rf-${stamp}`, second.total)).error?.message).toMatch(
      /another order/,
    )
    expect((await pay(second.id, `e2e-rf-low-${stamp}`, second.total - 1)).error?.message).toMatch(
      /below the total/,
    )
    const { error } = await db.rpc('record_order_payment', {
      p_order_id: second.id,
      p_provider_reference: `e2e-rf-usd-${stamp}`,
      p_amount_kobo: second.total,
      p_currency: 'USD',
      p_method: 'card',
      p_raw: {},
    })
    expect(error?.message).toMatch(/naira/)
  })

  it('refunds the excess of an overpayment and keeps the order', async () => {
    const user = await makeUser('over')
    const order = await makeOrder(user.id, [1_830_000], 'over')
    expect((await pay(order.id, `e2e-over-${stamp}`, order.total + 50_000)).data).toBe('paid')
    const refunds = await refundsFor(order.id)
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ reason: 'overpayment' })
    expect(Number(refunds[0]?.amount_kobo)).toBe(50_000)

    // If the line then fails, its refund still fits in the one charge.
    await failLines(order.id)
    const after = await refundsFor(order.id)
    expect(after.reduce((sum, refund) => sum + Number(refund.amount_kobo), 0)).toBe(
      order.total + 50_000,
    )
  })

  it('refunds a short payment in full, records it, and leaves the order unpaid', async () => {
    const user = await makeUser('under')
    const order = await makeOrder(user.id, [1_830_000], 'under')
    const underpay = () =>
      db.rpc('record_underpayment', {
        p_order_id: order.id,
        p_provider_reference: `e2e-under-${stamp}`,
        p_amount_kobo: 500_000,
        p_currency: 'NGN',
        p_method: 'banktransfer',
        p_raw: { flw_ref: `FLW-under-${stamp}` },
      })
    expect((await underpay()).error).toBeNull()
    expect((await underpay()).error).toBeNull()

    const refunds = await refundsFor(order.id)
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ reason: 'underpayment' })
    expect(Number(refunds[0]?.amount_kobo)).toBe(500_000)

    const { data: row } = await db.from('orders').select('status').eq('id', order.id).single()
    expect(row?.status).toBe('awaiting_payment')
    const { data: incidents } = await db
      .from('payment_incidents')
      .select('kind')
      .eq('order_id', order.id)
    expect(incidents).toEqual([{ kind: 'underpayment' }])
  })

  it('holds a refund over the automatic limit for a person, and the key cannot approve it', async () => {
    const user = await makeUser('held')
    const order = await makeOrder(user.id, [30_000_000], 'held')
    await pay(order.id, `e2e-held-a-${stamp}`, order.total)
    await pay(order.id, `e2e-held-b-${stamp}`, order.total)
    const [held] = await refundsFor(order.id)
    expect(held?.status).toBe('held')

    const { error } = await db.rpc(
      'approve_refund' as never,
      {
        p_refund_id: held?.id,
        p_by: 'the service key',
      } as never,
    )
    expect(error).not.toBeNull()

    const due = toDueAlerts((await db.rpc('sync_alerts', { p_test_mode: true })).data)
    expect(due).toContainEqual(
      expect.objectContaining({ kind: 'refund_held', severity: 'warning', type: 'new' }),
    )
  })

  it('never lets the service key write money rows directly', async () => {
    const user = await makeUser('direct')
    const order = await makeOrder(user.id, [1_830_000], 'direct')
    await pay(order.id, `e2e-direct-${stamp}`, order.total)
    const { data: payment } = await db
      .from('payments')
      .select('id')
      .eq('order_id', order.id)
      .single()

    const attempts = await Promise.all([
      db.from('payments').update({ amount_kobo: 1 }).eq('order_id', order.id).select(),
      db.from('payments').delete().eq('order_id', order.id).select(),
      db
        .from('refunds')
        .insert({
          order_id: order.id,
          payment_id: payment?.id ?? '',
          user_id: user.id,
          reason: 'duplicate_charge',
          amount_kobo: 1,
          test_mode: true,
        })
        .select(),
      db
        .from('ops_settings')
        .update({ auto_refund_max_kobo: 999_999_999_999 })
        .eq('id', true)
        .select(),
    ])
    for (const attempt of attempts) {
      expect(attempt.error?.message).toMatch(/permission denied/)
    }
  })

  it('walks a refund through send, submit and complete — and completion is final', async () => {
    const user = await makeUser('flow')
    const order = await makeOrder(user.id, [1_830_000], 'flow')
    await pay(order.id, `e2e-flow-a-${stamp}`, order.total)
    await pay(order.id, `e2e-flow-b-${stamp}`, order.total)
    const [refund] = await refundsFor(order.id)

    const claimed = await claimOurs(refund?.id ?? '')
    expect(claimed).toMatchObject({
      action: 'send',
      reason: 'duplicate_charge',
      amountKobo: order.total,
      chargedKobo: order.total,
      transactionId: `e2e-flow-b-${stamp}`,
      flwRef: `FLW-e2e-flow-b-${stamp}`,
      orderTxRef: `MDH-e2e-flow-${stamp}`,
      heldByOtherAccount: false,
      providerCalledAt: null,
      otherRefundsKobo: 0,
    })
    const id = claimed?.id ?? ''

    // Only the worker holding the claim may act on it.
    const intruder = await db.rpc('note_refund_provider_call', {
      p_refund_id: id,
      p_worker: 'another-worker',
    })
    expect(intruder.error?.message).toMatch(/not claimed by another-worker/)

    expect(
      (await db.rpc('note_refund_provider_call', { p_refund_id: id, p_worker: 'db-test' })).error,
    ).toBeNull()
    // Once Flutterwave may have it, "nothing was sent" is refused.
    const back = await db.rpc('reschedule_refund', {
      p_refund_id: id,
      p_worker: 'db-test',
      p_delay_seconds: 0,
      p_code: 'X',
      p_message: 'X',
      p_sent: false,
    })
    expect(back.error?.message).toMatch(/may have reached Flutterwave/)

    // Flutterwave reports it done: completed while the claim is held.
    expect(
      (
        await db.rpc('complete_refund', {
          p_refund_id: id,
          p_worker: 'db-test',
          p_provider_refund_id: `flw-refund-${stamp}`,
          p_provider_status: 'completed-mpgs',
        })
      ).error,
    ).toBeNull()
    // Completion releases the claim and is final: nothing moves it again.
    const again = await db.rpc('complete_refund', {
      p_refund_id: id,
      p_worker: 'db-test',
      p_provider_refund_id: `flw-refund-other-${stamp}`,
      p_provider_status: 'completed-mpgs',
    })
    expect(again.error?.message).toMatch(/not claimed/)
    expect(
      (
        await db.rpc('fail_refund', {
          p_refund_id: id,
          p_worker: 'db-test',
          p_code: 'X',
          p_message: 'X',
          p_needs_attention: true,
        })
      ).error,
    ).not.toBeNull()

    const { data: done } = await db
      .from('refunds')
      .select('status, provider_refund_id, completed_at')
      .eq('id', id)
      .single()
    expect(done).toMatchObject({ status: 'completed', provider_refund_id: `flw-refund-${stamp}` })
    const { data: history } = await db
      .from('refund_events')
      .select('event')
      .eq('refund_id', id)
      .order('id')
    expect(history?.map((row) => row.event)).toEqual([
      'queued',
      'sending',
      'provider_call',
      'completed',
    ])
  })

  it('refuses a lease too short to finish a Flutterwave call in', async () => {
    const { error } = await db.rpc('claim_refund', {
      p_worker: 'db-test',
      p_test_mode: true,
      p_lease_seconds: 5,
    })
    expect(error?.message).toMatch(/between one minute and an hour/)
  })

  it('never lets the service key record a manual refund', async () => {
    const { error } = await db.rpc(
      'record_manual_refund' as never,
      {
        p_refund_id: '00000000-0000-0000-0000-000000000000',
        p_provider_refund_id: '1',
        p_by: 'the service key',
      } as never,
    )
    expect(error?.message).toMatch(/permission denied/)
  })

  it('retrying a failed registration takes back its refund; failing again brings it back', async () => {
    const user = await makeUser('retry')
    const order = await makeOrder(user.id, [1_830_000], 'retry')
    await pay(order.id, `e2e-retry-${stamp}`, order.total)
    await failLines(order.id)
    const [refund] = await refundsFor(order.id)
    expect(refund).toMatchObject({ reason: 'registration_failed', status: 'queued' })

    const { data: job } = await db
      .from('jobs')
      .select('id')
      .eq('order_item_id', refund?.order_item_id ?? '')
      .single()
    expect((await db.rpc('retry_job', { p_job_id: job?.id ?? '' })).error).toBeNull()
    expect((await refundsFor(order.id))[0]?.status).toBe('cancelled')
    const { data: line } = await db
      .from('order_items')
      .select('status')
      .eq('id', refund?.order_item_id ?? '')
      .single()
    expect(line?.status).toBe('pending')
    const { data: reopened } = await db.from('orders').select('status').eq('id', order.id).single()
    expect(reopened?.status).toBe('provisioning')

    await failLines(order.id)
    const after = await refundsFor(order.id)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ id: refund?.id, status: 'queued' })
  })

  it('offers unpaid and recently paid orders to the payment sweeper, with the charges each has', async () => {
    const user = await makeUser('sweep')
    const unpaid = await makeOrder(user.id, [1_830_000], 'swp1')
    const paid = await makeOrder(user.id, [1_830_000], 'swp2')
    await pay(paid.id, `e2e-sweep-${stamp}`, paid.total)
    const due = async () =>
      (await db.rpc('orders_to_check', { p_test_mode: true, p_limit: 100 })).data ?? []
    // Orders in their first ten minutes are left to the redirect and webhook.
    expect((await due()).map((row) => row.id)).not.toContain(unpaid.id)

    // Age both orders past the first ten minutes.
    for (const id of [unpaid.id, paid.id]) {
      const { error } = await db
        .from('orders')
        .update({ created_at: new Date(Date.now() - 20 * 60_000).toISOString() })
        .eq('id', id)
      expect(error).toBeNull()
    }
    const rows = await due()
    expect(rows.find((row) => row.id === unpaid.id)?.known_references).toEqual([])
    // A paid order is looked at too — for a second charge nobody reported.
    expect(rows.find((row) => row.id === paid.id)?.known_references).toEqual([`e2e-sweep-${stamp}`])
    // Asked about now: not again for half an hour.
    const again = (await due()).map((row) => row.id)
    expect(again).not.toContain(unpaid.id)
    expect(again).not.toContain(paid.id)
  })

  it('keeps no customer or card details on a payment, whoever records it (N13)', async () => {
    const user = await makeUser('pii')
    const order = await makeOrder(user.id, [1_830_000], 'pii')
    const { error } = await db.rpc('record_order_payment', {
      p_order_id: order.id,
      p_provider_reference: `e2e-pii-${stamp}`,
      p_amount_kobo: order.total,
      p_currency: 'NGN',
      p_method: 'card',
      p_raw: {
        id: 4242,
        flw_ref: `FLW-pii-${stamp}`,
        amount: order.total / 100,
        status: 'successful',
        customer: { email: 'ada@example.com', name: 'Ada Obi', phone_number: '0803' },
        card: { token: 'flw-t1nf-secret', last_4digits: '2950' },
        ip: '102.89.1.1',
        device_fingerprint: 'abc',
        meta: { note: 'x' },
      },
    })
    expect(error).toBeNull()
    const { data } = await db.from('payments').select('raw').eq('order_id', order.id).single()
    expect(data?.raw).toEqual({
      id: 4242,
      flw_ref: `FLW-pii-${stamp}`,
      amount: order.total / 100,
      status: 'successful',
    })
  })

  it('shows people their own refunds, plainly, and nobody else’s', async () => {
    const owner = await makeUser('owner')
    const stranger = await makeUser('stranger')
    const order = await makeOrder(owner.id, [1_830_000], 'mine')
    await pay(order.id, `e2e-mine-a-${stamp}`, order.total)
    await pay(order.id, `e2e-mine-b-${stamp}`, order.total)

    const as = async (email: string) => {
      const client = createClient<Database>(
        env.NEXT_PUBLIC_SUPABASE_URL ?? '',
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      const { error } = await client.auth.signInWithPassword({ email, password })
      if (error) throw error
      return client
    }

    const mine = await (await as(owner.email)).rpc('my_order_refunds', { p_order_id: order.id })
    expect(mine.error).toBeNull()
    expect(mine.data).toEqual([
      expect.objectContaining({
        reason: 'duplicate_charge',
        amount_kobo: order.total,
        state: 'processing',
        test_mode: true,
      }),
    ])
    // Internal fields stay out of the customer's view.
    expect(Object.keys(mine.data?.[0] ?? {}).sort()).toEqual(
      ['amount_kobo', 'domain', 'id', 'reason', 'refunded_at', 'state', 'test_mode'].sort(),
    )

    const theirs = await (await as(stranger.email)).rpc('my_order_refunds', {
      p_order_id: order.id,
    })
    expect(theirs.data).toEqual([])

    // And the table itself is closed to them.
    const direct = await (await as(owner.email)).from('refunds').select('id')
    expect(direct.data ?? []).toEqual([])
  })

  it('raises an alert while a problem lasts, and clears it when it goes', async () => {
    const user = await makeUser('alerts')
    const order = await makeOrder(user.id, [1_830_000], 'alert')
    await db.rpc('record_underpayment', {
      p_order_id: order.id,
      p_provider_reference: `e2e-alert-${stamp}`,
      p_amount_kobo: 400_000,
      p_currency: 'NGN',
      p_method: 'banktransfer',
      p_raw: {},
    })
    const { data: incident } = await db
      .from('payment_incidents')
      .select('id')
      .eq('order_id', order.id)
      .single()
    const key = `incident:${incident?.id}`

    const sync = async () => toDueAlerts((await db.rpc('sync_alerts', { p_test_mode: true })).data)
    const findOurs = async () => {
      const { data } = await db
        .from('ops_alerts')
        .select('id, key, resolved_at, notified_at')
        .eq('key', key)
        .order('id', { ascending: false })
        .limit(1)
        .single()
      return data
    }

    const first = await sync()
    const ours = await findOurs()
    expect(first).toContainEqual(
      expect.objectContaining({ id: ours?.id, type: 'new', severity: 'critical' }),
    )
    await db.rpc('mark_alerts_notified', { p_alert_ids: [ours?.id ?? 0], p_resolved_ids: [] })
    // Sent, so not due again until the reminder interval.
    expect((await sync()).map((alert) => alert.id)).not.toContain(ours?.id)

    // The problem goes away: the alert resolves and is due once as cleared.
    await db.from('domains').delete().eq('user_id', user.id)
    await db.rpc('purge_test_orders', { p_user_id: user.id })
    const cleared = await sync()
    expect(cleared).toContainEqual(expect.objectContaining({ id: ours?.id, type: 'resolved' }))
    await db.rpc('mark_alerts_notified', { p_alert_ids: [], p_resolved_ids: [ours?.id ?? 0] })
    expect((await sync()).map((alert) => alert.id)).not.toContain(ours?.id)
  })

  /**
   * Regression: migration 15 added a second link between orders and payments,
   * and the API refused `orders → payments(...)` as ambiguous (PGRST201) —
   * every order page failed to load until migration 17 removed it.
   */
  it('keeps the order page’s embeds unambiguous', async () => {
    const { error } = await db
      .from('orders')
      .select('id, order_items(id), payments(provider_reference), refunds(id)')
      .limit(1)
    expect(error).toBeNull()
  })

  it('counts hits against a rate limit in one window', async () => {
    const key = `db-test:${stamp}`
    const hit = async () =>
      (await db.rpc('rate_limit_hit', { p_key: key, p_max: 2, p_window_seconds: 600 })).data
    expect([await hit(), await hit(), await hit()]).toEqual([true, true, false])
  })

  it('reports how many domains an account ordered today, against its cap (SEC-11)', async () => {
    const user = await makeUser('velocity')
    await makeOrder(user.id, [1_830_000, 1_830_000], 'vel')
    const { data } = await db.rpc('account_domain_allowance', { p_user_id: user.id })
    expect(data).toMatchObject({ ordered: 2 })
    expect((data as { max: number }).max).toBeGreaterThan(0)
  })
})
