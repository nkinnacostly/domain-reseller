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

export async function deleteTestUser(id) {
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
    for (const user of mine) await client.auth.admin.deleteUser(user.id)
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
