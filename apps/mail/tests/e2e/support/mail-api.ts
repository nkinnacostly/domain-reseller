/**
 * The v1 API's journey needs an account that can send and a worker that
 * does not reach SES (MAIL-SPEC §12: no e2e test ever calls real SES). Both
 * come from Mail's own SQL functions, as the worker and the SNS endpoint
 * call them:
 *
 *   readyAccount  — the person creates an account as themselves
 *                   (create_account), then `e2e_ready_account` marks its
 *                   tenant ready and adds a verified domain under the
 *                   reserved `.example` TLD (migration 45). It stays in the
 *                   sandbox, so it sends only to its own members.
 *   workAsSender  — `claim_sends` for this account only (the real worker's
 *                   claim never takes an e2e account's email), then
 *                   `record_send_result` with a made-up SES message id and
 *                   `record_send_event` for what SES would report.
 *
 * Nothing here logs an address, a key or a password.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import type { TestUser } from './accounts'

function env(name: string): string {
  if (process.env[name]) return process.env[name] as string
  const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [key, ...rest] = line.trim().split('=')
    if (key === name) return rest.join('=').replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} is not set`)
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } }

const service = () =>
  createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), noSession).schema(
    'mail',
  )

export type ReadyAccount = { accountId: string; domain: string }

export async function readyAccount(user: TestUser, name: string): Promise<ReadyAccount> {
  const client = createClient(
    env('NEXT_PUBLIC_SUPABASE_URL'),
    env('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    noSession,
  )
  const { error: signInError } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (signInError) throw signInError
  const created = await client.schema('mail').rpc('create_account', {
    p_name: name,
    p_website: 'https://acme.example',
    p_use_case: 'Receipts for the e2e journey.',
    p_expected_monthly_volume: 100,
  })
  await client.auth.signOut({ scope: 'local' })
  const accountId = (created.data as { accountId?: string } | null)?.accountId
  if (created.error || !accountId) throw created.error ?? new Error('create_account refused')

  const domain = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.e2e.example`
  const ready = await service().rpc('e2e_ready_account', {
    p_account_id: accountId,
    p_domain: domain,
  })
  if (ready.error || (ready.data as { ok?: boolean } | null)?.ok !== true) {
    throw ready.error ?? new Error('e2e_ready_account refused')
  }
  return { accountId, domain }
}

type Claimed = { id: number; publicId: string }

/**
 * What the worker and SES would do with one email of this account: claim it,
 * record SES's "sent", then the events SES would publish.
 */
export async function workAsSender(
  accountId: string,
  emailId: string,
  events: ('send' | 'delivery')[] = ['send', 'delivery'],
): Promise<void> {
  const worker = `e2e-worker-${Date.now()}`
  const claimed = await service().rpc('claim_sends', {
    p_worker: worker,
    p_limit: 20,
    p_paid_only: false,
    p_account_id: accountId,
  })
  if (claimed.error) throw claimed.error
  const mine = (claimed.data as Claimed[]).find((row) => row.publicId === emailId)
  if (!mine) throw new Error('the email was not claimable')
  const messageId = `e2e-${emailId}`
  const sent = await service().rpc('record_send_result', {
    p_email_id: mine.id,
    p_worker: worker,
    p_outcome: 'sent',
    p_message_id: messageId,
  })
  if (sent.error) throw sent.error
  for (const event of events) {
    const recorded = await service().rpc('record_send_event', {
      p_event: event,
      p_message_id: messageId,
      p_event_key: `${messageId}-${event}`,
      p_occurred_at: new Date().toISOString(),
    })
    if (recorded.error) throw recorded.error
  }
}
