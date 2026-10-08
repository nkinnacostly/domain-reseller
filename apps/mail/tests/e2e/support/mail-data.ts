/**
 * Mail rows for the events-and-webhooks journey (MAIL-SPEC §4.2, §6, §12),
 * made through the same SQL functions production uses — never a table
 * written by hand: an account its owner creates, made ready by
 * `e2e_ready_account` (a test account: the worker never takes its email or
 * its webhooks, and it never reaches SES), and one email queued, claimed and
 * "sent" with a made-up SES message id, as the worker would record it.
 * Addresses are e2e-*@example.com; nothing here is logged.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient } from '@supabase/supabase-js'
import type { TestUser } from './accounts'

function settings() {
  const path = fileURLToPath(new URL('../../../../../.env', import.meta.url))
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const [key, ...rest] = trimmed.split('=')
    if (key && !process.env[key]) process.env[key] = rest.join('=').replace(/^["']|["']$/g, '')
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !secret || !publishable) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and both Supabase keys must be set')
  }
  return { url, secret, publishable }
}

const noSession = { persistSession: false, autoRefreshToken: false }

/** The secret key, schema mail: only the functions granted to service_role. */
export function serviceMail() {
  const { url, secret } = settings()
  return createClient<Database, 'mail'>(url, secret, { db: { schema: 'mail' }, auth: noSession })
}

/**
 * Migration 58: the notification emails queued for an address, as the shop's
 * outbox holds them — e2e addresses are reserved, so each is `skipped`, never
 * sent. Kind, status and whether the data still holds a token; nothing else.
 */
export async function queuedEmailsFor(
  address: string,
): Promise<{ kind: string; status: string; hasToken: boolean }[]> {
  const { url, secret } = settings()
  const client = createClient<Database>(url, secret, { auth: noSession })
  const { data, error } = await client
    .from('email_outbox')
    .select('kind, status, data')
    .eq('to_email', address.toLowerCase())
  if (error) throw error
  return (data ?? []).map((row) => ({
    kind: row.kind,
    status: row.status,
    hasToken: typeof row.data === 'object' && row.data !== null && 'token' in row.data,
  }))
}

/** The person's own session, schema mail: what RLS lets them see. */
export async function signedInMail(user: TestUser) {
  const { url, publishable } = settings()
  const client = createClient<Database, 'mail'>(url, publishable, {
    db: { schema: 'mail' },
    auth: noSession,
  })
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw error
  return client
}

/** A ready test account the person owns, with a verified `.example` domain. */
export async function readyAccount(user: TestUser, name: string, domain: string): Promise<string> {
  const mine = await signedInMail(user)
  const { data, error } = await mine.rpc('create_account', { p_name: name })
  const answer = data as { ok?: boolean; accountId?: string } | null
  if (error || !answer?.ok || !answer.accountId) {
    throw error ?? new Error(`create_account: ${JSON.stringify(data)}`)
  }
  await mine.auth.signOut({ scope: 'local' })
  const { data: ready, error: readyError } = await serviceMail().rpc('e2e_ready_account', {
    p_account_id: answer.accountId,
    p_domain: domain,
  })
  if (readyError || (ready as { ok?: boolean } | null)?.ok !== true) {
    throw readyError ?? new Error(`e2e_ready_account: ${JSON.stringify(ready)}`)
  }
  return answer.accountId
}

/** One email to the person's own address, sent as far as SES's message id. */
export async function sentEmail(
  accountId: string,
  from: string,
  to: string,
  messageId: string,
): Promise<string> {
  const db = serviceMail()
  const { data: queued, error } = await db.rpc('enqueue_email', {
    p_account_id: accountId,
    // The API passes its key; a send made here has none, which SQL allows.
    p_api_key_id: null as unknown as string,
    p_email: { from, to: [to], subject: 'Your receipt (e2e)' },
    p_payload: { text: 'Thanks for your order. (e2e)' },
  })
  const answer = queued as { ok?: boolean; id?: string } | null
  if (error || !answer?.ok || !answer.id) {
    throw error ?? new Error(`enqueue_email: ${JSON.stringify(queued)}`)
  }
  const worker = 'e2e-mb4-sender'
  const { data: claimed, error: claimError } = await db.rpc('claim_sends', {
    p_worker: worker,
    p_limit: 1,
    p_paid_only: false,
    p_account_id: accountId,
  })
  const id = (claimed as { id?: number }[] | null)?.[0]?.id
  if (claimError || !id) throw claimError ?? new Error('claim_sends: nothing claimed')
  const { error: sentError } = await db.rpc('record_send_result', {
    p_email_id: id,
    p_worker: worker,
    p_outcome: 'sent',
    p_message_id: messageId,
  })
  if (sentError) throw sentError
  return answer.id
}

/** The email's status, read as its owner (RLS). */
export async function emailStatus(user: TestUser, emailId: string): Promise<string | null> {
  const mine = await signedInMail(user)
  const { data, error } = await mine
    .from('emails')
    .select('status')
    .eq('public_id', emailId)
    .maybeSingle()
  await mine.auth.signOut({ scope: 'local' })
  if (error) throw error
  return (data as { status?: string } | null)?.status ?? null
}
