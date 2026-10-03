/**
 * Seeds for the admin e2e suites (ADMIN-SPEC §3.2j, §8.1), through the
 * test-only SQL helpers, with the secret key. Each refuses anything but test
 * rows of e2e-*@example.com users, so a seed can never touch a customer's
 * record or real money (N12). Teardown purges the ledger rows seeded here.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

/**
 * The admin's own session at aal2 — password, then this code — for asking
 * SQL directly as them: a refusal the page never offers a button for (a test
 * administrator's "Redact reason", say) is still refused, and recorded.
 *
 * @param {{ user: { email: string, password: string } }} admin
 * @param {string} code a code from a window no other sign-in has spent
 */
export async function adminSqlSession(admin, code) {
  service()
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const signIn = await client.auth.signInWithPassword({
    email: admin.user.email,
    password: admin.user.password,
  })
  if (signIn.error) throw signIn.error
  const factors = await client.auth.mfa.listFactors()
  if (factors.error) throw factors.error
  const factor = factors.data.totp[0]
  if (!factor) throw new Error('admin-seed: the admin has no authenticator')
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code })
  if (verified.error) throw verified.error
  return client
}

function service() {
  const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** The address rule every test helper shares (`admin_e2e_email`, ADMIN-SPEC §2.7). */
const E2E_EMAIL = /^e2e-[^@]+@example\.com$/

/** Refuses anyone but an e2e-*@example.com user: a seed never touches a customer (N12). */
async function assertE2eUser(db, userId) {
  const { data, error } = await db.auth.admin.getUserById(userId)
  if (error) throw error
  if (!E2E_EMAIL.test(data.user?.email ?? '')) {
    throw new Error('admin-seed: only an e2e-*@example.com user may be seeded')
  }
}

const stampOf = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * A paid test order of one line for an e2e user (§8.1's `seedPaidTestOrder`),
 * paid through `record_order_payment` as the webhook pays one, so the line's
 * job is queued in the same transaction (migration 13). Test mode only: it
 * registers nowhere but the sandbox, and only `settleTestJob` moves its job.
 *
 * @param {string} userId
 * @param {{ kind?: 'register' | 'transfer', tag?: string, priceKobo?: number }} [options]
 * @returns {Promise<{ orderId: string, orderNumber: string, lineId: string, domain: string, providerReference: string, totalKobo: number }>}
 */
export async function seedPaidTestOrder(userId, options = {}) {
  const db = service()
  await assertE2eUser(db, userId)
  const kind = options.kind ?? 'register'
  const tag = (options.tag ?? 'admin').replace(/[^a-z0-9]/g, '')
  const priceKobo = options.priceKobo ?? 100_000
  // VAT at 7.5%, in whole kobo (N5).
  const vatKobo = Math.round((priceKobo * 75) / 1000)
  const stamp = stampOf()
  const domain = `e2e${tag}${stamp}.com`
  const providerReference = `e2e-${tag}-${stamp}`
  const { data: rate, error: rateError } = await db.from('fx_rates').select('id').limit(1).single()
  if (rateError) throw rateError
  const { data: order, error } = await db
    .from('orders')
    .insert({
      user_id: userId,
      subtotal_kobo: priceKobo,
      vat_pct: 7.5,
      vat_kobo: vatKobo,
      total_kobo: priceKobo + vatKobo,
      fx_rate_id: rate.id,
      tx_ref: `MDH-e2e-${tag}-${stamp}`,
      registrant: {},
      float_check: 'covered',
      test_mode: true,
    })
    .select('id, order_number')
    .single()
  if (error) throw error
  const { data: line, error: lineError } = await db
    .from('order_items')
    .insert({
      order_id: order.id,
      domain,
      tld: 'com',
      item_type: kind,
      period_years: 1,
      privacy: false,
      auto_renew: false,
      price_kobo: priceKobo,
      renewal_kobo: priceKobo,
    })
    .select('id')
    .single()
  if (lineError) throw lineError
  const paid = await db.rpc('record_order_payment', {
    p_order_id: order.id,
    p_provider_reference: providerReference,
    p_amount_kobo: priceKobo + vatKobo,
    p_currency: 'NGN',
    p_method: 'card',
    p_raw: { id: providerReference, status: 'successful' },
  })
  if (paid.error) throw paid.error
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    lineId: line.id,
    domain,
    providerReference,
    totalKobo: priceKobo + vatKobo,
  }
}

/**
 * Settles a seeded test order's job the way the worker fails one: claimed
 * by name, then `fail_job` with `code`. With `needsAttention` the job waits
 * for a person (nothing refunded); without, it fails and the line's refund
 * is queued. Only this order's jobs are claimed: the queue is shared.
 *
 * @param {string} orderId
 * @param {{ code: string, needsAttention: boolean }} outcome
 * @returns {Promise<string>} the job's id
 */
export async function settleTestJob(orderId, outcome) {
  const db = service()
  const { data: jobs, error } = await db
    .from('jobs')
    .select('id, test_mode, order_items!inner(order_id)')
    .eq('order_items.order_id', orderId)
  if (error) throw error
  const job = jobs?.[0]
  if (!job) throw new Error(`admin-seed: no job for order ${orderId}`)
  if (!job.test_mode) throw new Error('admin-seed: only a test-mode job is settled')
  const claim = await db.rpc('claim_job', { p_worker: 'e2e', p_test_mode: true, p_job_id: job.id })
  if (claim.error) throw claim.error
  const failed = await db.rpc('fail_job', {
    p_job_id: job.id,
    p_code: outcome.code,
    p_message: 'e2e',
    p_needs_attention: outcome.needsAttention,
  })
  if (failed.error) throw failed.error
  return job.id
}

/**
 * Sends one waiting test email and records its bounce, as the gateway and
 * the provider would (`claim_emails`, `mark_email_sent`,
 * `record_email_delivery`). The claim takes the oldest due test email, so
 * this waits until that is this one — it never takes another run's email —
 * and refuses anything but a test-mode email.
 *
 * @param {string} emailId
 */
export async function bounceTestEmail(emailId) {
  const db = service()
  const { data: email, error: readError } = await db
    .from('email_outbox')
    .select('test_mode')
    .eq('id', emailId)
    .single()
  if (readError) throw readError
  if (!email.test_mode) throw new Error('admin-seed: only a test-mode email is bounced')
  const worker = `e2e-bounce-${randomUUID()}`
  for (let attempt = 0; attempt < 60; attempt++) {
    const { data: due, error } = await db
      .from('email_outbox')
      .select('id')
      .eq('test_mode', true)
      .eq('status', 'pending')
      .lte('next_attempt_at', new Date().toISOString())
      .order('next_attempt_at')
      .order('created_at')
      .limit(1)
    if (error) throw error
    if (due?.[0]?.id === emailId) {
      const claimed = await db.rpc('claim_emails', {
        p_worker: worker,
        p_test_mode: true,
        p_limit: 1,
      })
      if (claimed.error) throw claimed.error
      const ids = (claimed.data ?? []).map((row) => row.id)
      if (ids.length !== 1 || ids[0] !== emailId) {
        throw new Error('admin-seed: the claim took another email than this one')
      }
      const sent = await db.rpc('mark_email_sent', {
        p_id: emailId,
        p_worker: worker,
        p_message_id: `e2e-bounce-${randomUUID()}`,
        p_template_version: 'e2e',
      })
      if (sent.error) throw sent.error
      if (sent.data !== true) throw new Error('admin-seed: the email was not marked sent')
      const bounced = await db.rpc('record_email_delivery', { p_id: emailId, p_status: 'bounced' })
      if (bounced.error) throw bounced.error
      if (bounced.data !== true) throw new Error('admin-seed: the bounce was not recorded')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('admin-seed: another test email stayed ahead of this one in the queue')
}

/** Moves a queued test refund to held, as if it were over a limit. */
export async function holdTestRefund(refundId) {
  const { error } = await service().rpc('hold_test_refund', { p_refund_id: refundId })
  if (error) throw error
}

/** Queues one failed test email for the user, for "Send again". Returns its id. */
export async function seedTestFailedEmail(userId) {
  const { data, error } = await service().rpc('seed_test_failed_email', { p_user_id: userId })
  if (error) throw error
  return data
}

/**
 * Records test-side supplier ledger rows as the sync would. Descriptions are
 * prefixed `e2e-` so teardown's purge finds them; times carry their zone.
 *
 * @param {{ description: string, deltaCents: number, balanceBeforeCents?: number, occurredAt?: string, type?: number }[]} rows
 */
export async function seedTestLedgerEntries(rows) {
  const payload = rows.map((row) => {
    const before = row.balanceBeforeCents ?? 100_000
    return {
      traceId: randomUUID(),
      occurredAt: row.occurredAt ?? new Date().toISOString(),
      type: row.type ?? (row.deltaCents < 0 ? 2 : 1),
      status: 1,
      chargeType: 0,
      productType: 0,
      productId: null,
      description: row.description.startsWith('e2e-') ? row.description : `e2e-${row.description}`,
      period: null,
      oldBalanceCents: before,
      balanceCents: before + row.deltaCents,
    }
  })
  const { data, error } = await service().rpc('record_supplier_ledger', {
    p_test_mode: true,
    p_rows: payload,
  })
  if (error) throw error
  return { result: data, traceIds: payload.map((row) => row.traceId) }
}
