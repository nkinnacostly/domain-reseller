/**
 * Test accounts for Playwright, created and removed through the Supabase
 * admin API.
 *
 * Users are created already confirmed, so no email is ever sent: sign-up
 * through the UI would send real confirmation mail to made-up addresses, and
 * bounces count against the project's sender reputation. Addresses use the
 * reserved example.com domain and a run-specific prefix, so cleanup can find
 * every one — including leftovers from an aborted run.
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

export const TEST_EMAIL_PREFIX = 'e2e-'
export const TEST_EMAIL_DOMAIN = 'example.com'
export const TEST_PASSWORD = 'e2e-Correct-Horse-9'

function loadEnv() {
  const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
}

function admin() {
  loadEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export async function createTestUser(label, { fullName = 'Test Person' } = {}) {
  const email = `${TEST_EMAIL_PREFIX}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@${TEST_EMAIL_DOMAIN}`
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error) throw error
  return { id: data.user.id, email, password: TEST_PASSWORD }
}

/**
 * Orders refuse deletion while they exist (money records), so remove a test
 * user's first. Payments and refunds cannot be deleted directly, even with
 * the secret key: purge_test_orders removes them, and refuses live orders.
 */
async function deleteOrdersFor(client, userId) {
  await client.from('domains').delete().eq('user_id', userId)
  const { error } = await client.rpc('purge_test_orders', { p_user_id: userId })
  if (error) throw error
}

export async function deleteTestUser(id) {
  await deleteOrdersFor(admin(), id)
  const { error } = await admin().auth.admin.deleteUser(id)
  if (error && error.status !== 404) throw error
}

/** Removes every test account, including leftovers from interrupted runs. */
export async function deleteAllTestUsers() {
  const client = admin()
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    const mine = data.users.filter(
      (user) =>
        user.email?.startsWith(TEST_EMAIL_PREFIX) && user.email.endsWith(`@${TEST_EMAIL_DOMAIN}`),
    )
    for (const user of mine) {
      await deleteOrdersFor(client, user.id)
      await client.auth.admin.deleteUser(user.id)
    }
    if (data.users.length < 200) break
  }
}

/** The current RFC 6238 code for a base32 secret — what an authenticator app shows. */
export function totpCode(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of secret.replace(/\s|=/g, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 15
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** Simulates a recent password reset, which starts the 24-hour hold (FR-A6). */
export async function setPasswordResetAt(id, iso) {
  const { error } = await admin().from('profiles').update({ password_reset_at: iso }).eq('id', id)
  if (error) throw error
}

/** Waits out the tail of a 30-second window so a code cannot expire mid-submit. */
export async function freshTotpCode(secret) {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30)
  if (left < 5) await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000))
  return totpCode(secret)
}

/** Test domains all start with this, so their carts can be found and removed. */
export const TEST_DOMAIN_PREFIX = 'e2ecart'

/**
 * Removes carts the tests created: any cart holding a test domain, and empty
 * anonymous carts from the last few hours (a test that removes its only line
 * leaves one). User carts go with their test users (on delete cascade).
 */
export async function deleteTestCarts() {
  const client = admin()
  const { data: items, error } = await client
    .from('cart_items')
    .select('cart_id')
    .like('domain', `${TEST_DOMAIN_PREFIX}%`)
  if (error) throw error
  const ids = [...new Set((items ?? []).map((item) => item.cart_id))]
  if (ids.length) await client.from('carts').delete().in('id', ids)

  const since = new Date(Date.now() - 3 * 3_600_000).toISOString()
  const { data: recent } = await client
    .from('carts')
    .select('id, cart_items(count)')
    .is('user_id', null)
    .gte('created_at', since)
  const empty = (recent ?? [])
    .filter((cart) => (cart.cart_items?.[0]?.count ?? 0) === 0)
    .map((cart) => cart.id)
  if (empty.length) await client.from('carts').delete().in('id', empty)
}

const DAY_MS = 86_400_000

/**
 * A demo domain row — `source = 'demo'`, labelled "Demo" wherever it shows.
 * Registration is not wired yet, so this is how the management screens get
 * something to manage in tests and demos. Never touches the registrar.
 *
 * @param {string} userId
 * @param {{ name?: string, status?: string, expiresInDays?: number, autoRenew?: boolean }} [options]
 */
export async function createDemoDomain(userId, options = {}) {
  const { name, status = 'active', expiresInDays = 200, autoRenew = true } = options
  const client = admin()
  const domainName =
    name ??
    `${TEST_DOMAIN_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.com`
  const registered =
    status === 'pending' ? null : new Date(Date.now() - (365 - expiresInDays) * DAY_MS)
  const { data, error } = await client
    .from('domains')
    .insert({
      user_id: userId,
      domain_name: domainName,
      tld: domainName.split('.').slice(1).join('.'),
      source: 'demo',
      local_status: status,
      registered_at: registered?.toISOString() ?? null,
      expires_at:
        status === 'pending' ? null : new Date(Date.now() + expiresInDays * DAY_MS).toISOString(),
      auto_renew: autoRenew,
      privacy_enabled: true,
    })
    .select('id, domain_name')
    .single()
  if (error) throw error
  await client
    .from('domain_events')
    .insert({ domain_id: data.id, event_type: 'demo_created', actor_type: 'system' })
  return { id: data.id, name: data.domain_name }
}

/** Turns on TOTP for a test user through the API and returns its secret. */
export async function enableTotp(user) {
  loadEnv()
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  )
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (signInError) throw signInError
  const { data, error } = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Test authenticator',
  })
  if (error) throw error
  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
    factorId: data.id,
    code: await freshTotpCode(data.totp.secret),
  })
  if (verifyError) throw verifyError
  await client.auth.signOut({ scope: 'local' })
  return data.totp.secret
}

/**
 * What the gateway worker records once the registry has answered, through
 * the same database functions (migration 13). The registry itself is not
 * involved — `outcome` is 'registered' or a failure code such as
 * 'DOMAIN_TAKEN'. Claims only this order's jobs: the queue is shared.
 *
 * @param {string} orderId
 * @param {string} outcome
 */
export async function settleRegistration(orderId, outcome) {
  const client = admin()
  const { data: jobs, error } = await client
    .from('jobs')
    .select('id, test_mode, order_items!inner(order_id)')
    .eq('order_items.order_id', orderId)
  if (error) throw error
  if (!jobs?.length) throw new Error(`No registration jobs for order ${orderId}`)
  for (const job of jobs) {
    const claim = await client.rpc('claim_job', {
      p_worker: 'e2e',
      p_test_mode: job.test_mode,
      p_job_id: job.id,
    })
    if (claim.error) throw claim.error
    const result =
      outcome === 'registered'
        ? await client.rpc('complete_registration', {
            p_job_id: job.id,
            p_registered_at: new Date().toISOString(),
            p_expires_at: new Date(Date.now() + 365 * DAY_MS).toISOString(),
            p_nameservers: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
            p_transfer_lock: true,
            p_privacy: false,
            p_recovered: false,
            p_nameserver_result: 'none',
          })
        : await client.rpc('fail_job', {
            p_job_id: job.id,
            p_code: outcome,
            p_message: 'e2e',
            p_needs_attention: false,
          })
    if (result.error) throw result.error
  }
}

/**
 * A domain registered in the registrar's sandbox from a test payment — the
 * state a settled test order leaves behind — without buying it first.
 *
 * @param {string} userId
 * @param {{ expiresInDays?: number }} [options]
 */
export async function createSandboxDomain(userId, { expiresInDays = 200 } = {}) {
  const client = admin()
  const domainName = `${TEST_DOMAIN_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.com`
  const { data, error } = await client
    .from('domains')
    .insert({
      user_id: userId,
      domain_name: domainName,
      tld: 'com',
      source: 'registration',
      test_mode: true,
      local_status: 'active',
      registered_at: new Date(Date.now() - (365 - expiresInDays) * DAY_MS).toISOString(),
      expires_at: new Date(Date.now() + expiresInDays * DAY_MS).toISOString(),
      auto_renew: true,
      privacy_enabled: false,
    })
    .select('id, domain_name, expires_at')
    .single()
  if (error) throw error
  return { id: data.id, name: data.domain_name, expiresAt: data.expires_at }
}

/**
 * Moves an order's renewal jobs the way the gateway worker would, without a
 * registry: 'renewed' records the baseline and the new expiry read back
 * (migration 23); any other outcome is a refusal code, refunded.
 */
export async function settleRenewal(orderId, outcome) {
  const client = admin()
  const { data: jobs, error } = await client
    .from('jobs')
    .select('id, test_mode, domain_id, order_items!inner(order_id, period_years)')
    .eq('order_items.order_id', orderId)
    .eq('kind', 'renew_domain')
  if (error) throw error
  if (!jobs?.length) throw new Error(`No renewal jobs for order ${orderId}`)
  for (const job of jobs) {
    const claim = await client.rpc('claim_job', {
      p_worker: 'e2e',
      p_test_mode: job.test_mode,
      p_job_id: job.id,
    })
    if (claim.error) throw claim.error
    if (outcome !== 'renewed') {
      const failed = await client.rpc('fail_job', {
        p_job_id: job.id,
        p_code: outcome,
        p_message: 'e2e',
        p_needs_attention: false,
      })
      if (failed.error) throw failed.error
      continue
    }
    const { data: domain, error: domainError } = await client
      .from('domains')
      .select('expires_at')
      .eq('id', job.domain_id)
      .single()
    if (domainError) throw domainError
    const baseline = await client.rpc('note_renewal_baseline', {
      p_job_id: job.id,
      p_expires_at: domain.expires_at,
    })
    if (baseline.error) throw baseline.error
    const renewed = new Date(domain.expires_at)
    renewed.setUTCFullYear(renewed.getUTCFullYear() + job.order_items.period_years)
    const done = await client.rpc('complete_renewal', {
      p_job_id: job.id,
      p_expires_at: renewed.toISOString(),
      p_recovered: false,
    })
    if (done.error) throw done.error
  }
}

/**
 * Sets columns on a test domain directly — a registrant for the Contacts tab,
 * or a state the UI cannot reach on its own. Test rows only.
 *
 * @param {string} domainId
 * @param {Record<string, unknown>} fields
 */
export async function updateTestDomain(domainId, fields) {
  const { error } = await admin().from('domains').update(fields).eq('id', domainId)
  if (error) throw error
}

/**
 * Answers a domain's open settings job the way the gateway worker does,
 * without a registry (migration 26): claim it, then record_domain_change
 * with what the registry now holds — the requested value when `outcome` is
 * 'applied', or null and `outcome` as the refusal code.
 *
 * @param {string} domainId
 * @param {'set_transfer_lock' | 'set_privacy' | 'update_contacts'} kind
 * @param {string} [outcome]
 */
export async function settleDomainChange(domainId, kind, outcome = 'applied') {
  const client = admin()
  const { data: jobs, error } = await client
    .from('jobs')
    .select('id, test_mode')
    .eq('domain_id', domainId)
    .eq('kind', kind)
    .in('status', ['queued', 'running'])
  if (error) throw error
  if (!jobs?.length) throw new Error(`No open ${kind} job for domain ${domainId}`)
  for (const job of jobs) {
    const claim = await client.rpc('claim_job', {
      p_worker: 'e2e',
      p_test_mode: job.test_mode,
      p_job_id: job.id,
    })
    if (claim.error) throw claim.error
    const context = claim.data ?? {}
    const attempted =
      kind === 'set_transfer_lock'
        ? { transfer_lock: context.pending_transfer_lock }
        : kind === 'set_privacy'
          ? { privacy: context.pending_privacy }
          : { registrant: context.pending_registrant }
    const recorded = await client.rpc('record_domain_change', {
      p_job_id: job.id,
      p_attempted: attempted,
      p_applied: outcome === 'applied' ? attempted : null,
      p_code: outcome === 'applied' ? null : outcome,
    })
    if (recorded.error) throw recorded.error
  }
}
