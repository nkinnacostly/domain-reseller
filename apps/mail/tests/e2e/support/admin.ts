import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test as base, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { createTestUser, type TestUser } from './accounts'

/**
 * Mail's admin suite (MAIL-SPEC §10, M5), as the shop's (ADMIN-SPEC §8.1):
 *
 * - its own `test`: no screenshot, video, trace or error-context, even on a
 *   failure — an admin page can show an account's details, and artifacts are
 *   uploaded from CI;
 * - `test_only` admins only, made from e2e users with `grant_test_admin`
 *   (migration 40), which SQL keeps to e2e accounts; never a real admin;
 * - e2e accounts only (migration 45's rule), readied, seeded and purged
 *   through the e2e functions. No AWS call: the e2e server has no SES key.
 */

export const test = base.extend<{ noErrorContext: undefined }>({
  screenshot: 'off',
  video: 'off',
  trace: 'off',
  noErrorContext: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's needs from this pattern
    async ({}, use, testInfo) => {
      const outputPath = testInfo.outputPath.bind(testInfo)
      testInfo.outputPath = (...segments: string[]) =>
        segments.length === 1 && segments[0] === 'error-context.md'
          ? devNull
          : outputPath(...segments)
      await use(undefined)
    },
    { auto: 'all-hooks-included' as unknown as boolean },
  ],
})

export { expect }

/** Sign-ins are rate-limited per address: these two projects only. */
export const SIGN_IN_PROJECTS = ['chromium-desktop', 'mobile-ios']

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

/** The root .env, as accounts.ts reads it: values already set win. */
function loadEnv() {
  const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
}

function settings() {
  loadEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !secret || !publishable) throw new Error('Supabase settings missing')
  return { url, secret, publishable }
}

const service = () => {
  const { url, secret } = settings()
  return createClient(url, secret, noSession)
}

/** RFC 6238 with SHA-1, as authenticator apps compute it. */
export function totpCode(secret: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of secret.replace(/\s|=/g, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 15
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

const window30 = (ms: number) => Math.floor(ms / 30_000)

/**
 * A code from a window after `after` (ms) with five seconds left in it:
 * Supabase takes a code once, and enrolling spent that window's.
 */
export async function codeAfter(secret: string, after: number): Promise<string> {
  while (window30(Date.now()) <= window30(after) || 30 - ((Date.now() / 1000) % 30) < 5) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return totpCode(secret)
}

export type AdminUser = { user: TestUser; totpSecret: string; enrolledAt: number; label: string }

/** Whether migration 51 is on the database: without it the enrolled journeys skip. */
export async function hasSafetySchema(): Promise<boolean> {
  const { error } = await service().schema('mail').rpc('e2e_evaluate', {
    p_account_id: '00000000-0000-0000-0000-000000000000',
  })
  return !error
}

/**
 * Whether migration 54 is applied: billing_return_allowed answers false for
 * a checkout that does not exist, and is missing before it.
 */
export async function hasFollowupsSchema(): Promise<boolean> {
  const none = '00000000-0000-0000-0000-000000000000'
  const { error } = await service().schema('mail').rpc('billing_return_allowed', {
    p_checkout_id: none,
    p_account_id: none,
  })
  return !error
}

/** An e2e user with an authenticator, made a test-only operator (ADMIN-SPEC §2.7). */
export async function createAdminTestUser(): Promise<AdminUser> {
  const user = await createTestUser('admin', 'Test Admin')
  const { url, publishable } = settings()
  const client = createClient(url, publishable, noSession)
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
  const enrolledAt = Date.now()
  const { error: verifyError } = await client.auth.mfa.challengeAndVerify({
    factorId: data.id,
    code: totpCode(data.totp.secret, enrolledAt),
  })
  if (verifyError) throw verifyError
  await client.auth.signOut({ scope: 'local' })
  const { data: label, error: grantError } = await service().rpc('grant_test_admin', {
    p_user_id: user.id,
  })
  if (grantError || typeof label !== 'string')
    throw grantError ?? new Error('grant_test_admin answered nothing')
  return { user, totpSecret: data.totp.secret, enrolledAt, label }
}

/**
 * A sandbox account owned by an e2e user, ready for review: a complete
 * profile (§7.1), a verified `.example` domain and its tenant marked made
 * (e2e_ready_account) — never a real SES identity or tenant.
 */
export async function createReadyAccount(owner: TestUser, name: string): Promise<string> {
  const { url, publishable } = settings()
  const client = createClient(url, publishable, noSession)
  const { error: signInError } = await client.auth.signInWithPassword({
    email: owner.email,
    password: owner.password,
  })
  if (signInError) throw signInError
  const { data, error } = await client.schema('mail').rpc('create_account', {
    p_name: name,
    p_website: 'https://shop.example',
    p_use_case: 'Order receipts and sign-in links for our shop.',
    p_expected_monthly_volume: 2000,
  })
  await client.auth.signOut({ scope: 'local' })
  const accountId = (data as { accountId?: string } | null)?.accountId
  if (error || !accountId) throw error ?? new Error(`create_account: ${JSON.stringify(data)}`)
  const domain = `mb6-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.example`
  const { data: ready, error: readyError } = await service()
    .schema('mail')
    .rpc('e2e_ready_account', { p_account_id: accountId, p_domain: domain })
  if (readyError || (ready as { ok?: boolean } | null)?.ok !== true) {
    throw readyError ?? new Error(`e2e_ready_account: ${JSON.stringify(ready)}`)
  }
  return accountId
}

/** The threshold job on one e2e account (§7.4): today's sends and bounces, then judged. */
export async function seedThresholdPause(accountId: string, sent: number, bounced: number) {
  const db = service().schema('mail')
  const { data: seeded, error } = await db.rpc('e2e_seed_usage', {
    p_account_id: accountId,
    p_sent: sent,
    p_bounced: bounced,
    p_complained: 0,
  })
  if (error || (seeded as { ok?: boolean } | null)?.ok !== true)
    throw error ?? new Error('e2e_seed_usage')
  const { data, error: evaluateError } = await db.rpc('e2e_evaluate', { p_account_id: accountId })
  if (evaluateError) throw evaluateError
  return data as { ok: boolean; paused?: boolean }
}

/** The account and its people go; the admin's audit rows age out by cron (D15). */
export async function cleanUp(options: {
  accountIds?: string[]
  users?: (TestUser | undefined)[]
}) {
  const client = service()
  for (const accountId of options.accountIds ?? []) {
    await client.schema('mail').rpc('e2e_purge_account', { p_account_id: accountId })
  }
  for (const user of options.users ?? []) {
    if (!user) continue
    const { error } = await client.auth.admin.deleteUser(user.id)
    if (error && error.status !== 404) throw error
  }
}

/** Signs in with the password at /sign-in?next=…, then a fresh code on /verify. */
export async function signInAsAdmin(page: Page, admin: AdminUser, next = '/admin') {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`)
  const form = page.getByRole('form', { name: 'Sign in', exact: true })
  await form.getByLabel('Email').fill(admin.user.email)
  await form.getByLabel('Password', { exact: true }).fill(admin.user.password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/verify/, { timeout: 30_000 })
  const verify = page.getByRole('form', { name: 'Two-factor code' })
  await verify.getByLabel('6-digit code').fill(await codeAfter(admin.totpSecret, admin.enrolledAt))
  await verify.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), {
    timeout: 30_000,
  })
}
