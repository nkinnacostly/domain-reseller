/**
 * Billing's e2e helpers: a test person's Mail account made as them (their
 * password, the publishable key — the secret key reads no Mail table), and
 * the mock Flutterwave's renewal control. Nothing here logs an address.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import type { TestUser } from './accounts'

function env(name: string): string {
  if (!process.env[name]) {
    const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const [key, ...rest] = line.trim().split('=')
      if (key === name) process.env[name] = rest.join('=').replace(/^["']|["']$/g, '')
    }
  }
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set`)
  return value
}

/** A Mail account owned by the person, as onboarding makes one (create_account). */
export async function createTestAccount(user: TestUser, name: string): Promise<string> {
  const client = createClient(
    env('NEXT_PUBLIC_SUPABASE_URL'),
    env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  )
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (signInError) throw signInError
  const { data, error } = await client.schema('mail').rpc('create_account', {
    p_name: name,
    p_website: 'billing.example',
    p_use_case: 'Order receipts for an e2e shop.',
    p_expected_monthly_volume: 1000,
  })
  await client.auth.signOut({ scope: 'local' })
  const accountId = (data as { accountId?: string } | null)?.accountId
  if (error || !accountId) throw error ?? new Error(`create_account: ${JSON.stringify(data)}`)
  return accountId
}

export const MOCK_FLUTTERWAVE = `http://127.0.0.1:${Number(process.env.MOCK_FLUTTERWAVE_PORT ?? 4301)}`

/**
 * Flutterwave's renewal run, played by the mock: it charges the person's
 * latest subscription again and sends the webhook to the app, as Paidly
 * forwards it. Answers the app's status for that webhook.
 */
export async function renewOnMock(email: string, status: 'successful' | 'failed'): Promise<number> {
  const response = await fetch(`${MOCK_FLUTTERWAVE}/flw/test/renewal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer_email: email, status }),
  })
  const body = (await response.json()) as { ok?: boolean; webhookStatus?: number }
  if (!response.ok || !body.ok) throw new Error(`renewal on the mock failed: ${response.status}`)
  return body.webhookStatus ?? 0
}

/**
 * Brings the e2e subscription's period end to `at` (migration 55; e2e accounts
 * only). A failed renewal marks an account past due only near its period's
 * end (migration 54, item 22), so the past-due journey sets the end first.
 */
export async function setPeriodEnd(accountId: string, at: Date): Promise<void> {
  const client = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client
    .schema('mail')
    .rpc('e2e_set_period_end', { p_account_id: accountId, p_period_end: at.toISOString() })
  if (error) throw error
}
