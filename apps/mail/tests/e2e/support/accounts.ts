/**
 * Test people and their Mail accounts for Playwright, made and removed
 * through Supabase's admin API and Mail's e2e functions (migrations 45–46).
 *
 * People are created already confirmed, so no email is ever sent: a sign-up
 * through the UI would mail a made-up address, and bounces count against the
 * sender (CLAUDE.md §15). Addresses are e2e-*@example.com, the only ones the
 * e2e functions act on. Nothing here logs an address or a password.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

export const TEST_PASSWORD = 'e2e-Correct-Horse-9'

export type TestUser = { id: string; email: string; password: string }

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
  if (!url || !secret || !publishable) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and both Supabase keys must be set')
  }
  return { url, secret, publishable }
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

function admin() {
  const { url, secret } = settings()
  return createClient(url, secret, noSession)
}

export async function createTestUser(label: string, fullName = 'Test Person'): Promise<TestUser> {
  const email = `e2e-mail-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error || !data.user) throw error ?? new Error('no user')
  return { id: data.user.id, email, password: TEST_PASSWORD }
}

/**
 * The Mail accounts a person belongs to, read as them: the secret key reads
 * no Mail table (migration 44), so this signs in with their password.
 */
export async function mailAccountIdsOf(user: TestUser): Promise<string[]> {
  const { url, publishable } = settings()
  const client = createClient(url, publishable, noSession)
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (signInError) throw signInError
  const { data, error } = await client.schema('mail').from('members').select('account_id')
  if (error) throw error
  await client.auth.signOut({ scope: 'local' })
  return (data ?? []).map((row: { account_id: string }) => row.account_id)
}

/** Moves an e2e account to another plan: the Free plan has a single seat. */
export async function setTestPlan(accountId: string, plan: string): Promise<void> {
  const { data, error } = await admin().schema('mail').rpc('e2e_set_plan', {
    p_account_id: accountId,
    p_plan_code: plan,
  })
  if (error || data?.ok !== true) throw error ?? new Error(`e2e_set_plan: ${JSON.stringify(data)}`)
}

/** Deletes a test person's Mail accounts (every member an e2e user), then the person. */
export async function deleteTestUser(user: TestUser): Promise<void> {
  const client = admin()
  let accounts: string[] = []
  try {
    accounts = await mailAccountIdsOf(user)
  } catch {
    // A person who never signed in has no accounts.
  }
  for (const accountId of accounts) {
    await client.schema('mail').rpc('e2e_purge_account', { p_account_id: accountId })
  }
  const { error } = await client.auth.admin.deleteUser(user.id)
  if (error && error.status !== 404) throw error
}
