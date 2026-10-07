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
  const { error } = await serviceClient()
    .schema('mail')
    .rpc('e2e_set_period_end', { p_account_id: accountId, p_period_end: at.toISOString() })
  if (error) throw error
}

function serviceClient() {
  return createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Whether migration 56 is applied (a second renewal in one month recorded,
 * not applied): begin_billing_jobs refuses a made-up token, and is missing
 * before it. Nothing is recorded for a refused token.
 */
export async function hasDuplicatesSchema(): Promise<boolean> {
  const { data, error } = await serviceClient().schema('mail').rpc('begin_billing_jobs', {
    p_token: 'e2e-probe-not-the-token',
    p_test_mode: true,
    p_api_host: '127.0.0.1',
    p_limit: 1,
  })
  return !error && (data as { code?: string } | null)?.code === 'unauthorized'
}

async function mock(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${MOCK_FLUTTERWAVE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const answer = (await response.json()) as Record<string, unknown>
  if (!response.ok || answer.ok !== true) {
    throw new Error(`mock Flutterwave ${path} failed: ${response.status}`)
  }
  return answer
}

/**
 * The person's next payment starts two subscriptions on its one charge, as a
 * live test-mode run did (7 Oct 2026: charge 10534506, subscriptions 53194
 * and 53195 three minutes apart).
 */
export async function duplicateNextPayment(email: string): Promise<void> {
  await mock('/flw/test/duplicate-next-payment', { customer_email: email })
}

/** A second subscription on the person's first charge, turning up after it was settled. */
export async function addDuplicateSubscription(email: string): Promise<number> {
  return Number((await mock('/flw/test/duplicate-subscription', { customer_email: email })).id)
}

export type MockSubscription = { id: number; status: string; firstTransactionId: number }

/** The person's subscriptions at the mock, earliest-made first. */
export async function subscriptionsOnMock(email: string): Promise<MockSubscription[]> {
  const answer = await mock(`/flw/test/subscriptions?customer_email=${encodeURIComponent(email)}`)
  return answer.subscriptions as MockSubscription[]
}

/**
 * Flutterwave's renewal run for every active subscription of the person,
 * earliest-made first, each webhook answered before the next charge. Answers
 * the app's status for each.
 */
export async function renewAllOnMock(
  email: string,
  status: 'successful' | 'failed',
): Promise<number[]> {
  const answer = await mock('/flw/test/renewal', { customer_email: email, status, all: true })
  return answer.webhookStatuses as number[]
}
