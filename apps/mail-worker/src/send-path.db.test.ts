import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database, Json } from '@dr/db'
import {
  hashApiKey,
  newApiKey,
  requestHash,
  sendEmailSchema,
  sqlRefusalSchema,
  toEnqueueInput,
} from '@dr/shared/mail'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { claimedEmailSchema, createMailStore, type MailClient } from './store'

/**
 * Mail's send path against the hosted database (migrations 43–45), through
 * PostgREST with the real keys and grants: a person signs in and creates an
 * account and a key (their session, RLS); the API's secret key checks the
 * key and queues an email (enqueue_email, with Idempotency-Key); the worker
 * claims it and records SES's answer (claim_sends, record_send_result). No
 * email is sent: the account is a test account (every member an
 * e2e-*@example.com user), its domain is under the reserved `.example` TLD,
 * and the worker's own claim never takes a test account's email.
 *
 *   DB_TESTS=1 pnpm --filter @dr/mail-worker exec vitest run src/send-path.db.test.ts
 *
 * Its e2e user and account are purged afterwards (e2e_purge_account). It
 * reads the root .env itself and never prints a key or the pepper.
 */

const enabled = process.env.DB_TESTS === '1'

function readEnv(): Record<string, string> {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
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

/**
 * Migration 45's helpers and `claim_sends`'s account argument, typed here
 * until the generated types know them (regenerate after applying 45, then
 * call them through `service.rpc` directly).
 */
type Pending = {
  e2e_ready_account: { args: { p_account_id: string; p_domain: string } }
  e2e_purge_account: { args: { p_account_id: string } }
  claim_sends: {
    args: { p_worker: string; p_limit: number; p_paid_only: boolean; p_account_id: string }
  }
}
const call = <K extends keyof Pending>(client: MailClient, fn: K, args: Pending[K]['args']) =>
  (
    client.rpc as unknown as (
      fn: string,
      args: object,
    ) => PromiseLike<{ data: Json; error: { code?: string } | null }>
  )(fn, args)

const ok = z.looseObject({ ok: z.literal(true) })

describe.skipIf(!enabled)('the send path against the database', () => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const email = `e2e-mail-${stamp}@example.com`
  const password = `e2e-${stamp}-Pw-9`
  const domain = `m${stamp}.e2e.example`
  const worker = `db-test:${stamp}`

  let auth: SupabaseClient<Database>
  let service: MailClient
  let asUser: MailClient
  let pepper = ''
  let userId = ''
  let accountId = ''
  let shortId = ''
  let keyHash = ''
  let emailId = ''

  beforeAll(async () => {
    const env = readEnv()
    const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    const secret = env.SUPABASE_SECRET_KEY ?? ''
    pepper = env.MAIL_API_KEY_PEPPER ?? ''
    if (!url || !secret || !pepper || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
      throw new Error('the root .env needs the Supabase URL and keys and MAIL_API_KEY_PEPPER')
    }
    const options = { auth: { persistSession: false, autoRefreshToken: false } }
    auth = createClient<Database>(url, secret, options)
    service = createClient<Database, 'mail'>(url, secret, { ...options, db: { schema: 'mail' } })
    asUser = createClient<Database, 'mail'>(url, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      ...options,
      db: { schema: 'mail' },
    })
    const { data, error } = await auth.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error || !data.user) throw new Error(error?.message ?? 'no user')
    userId = data.user.id
    const signedIn = await asUser.auth.signInWithPassword({ email, password })
    if (signedIn.error) throw new Error(signedIn.error.message)
  })

  afterAll(async () => {
    if (accountId) {
      const purged = await call(service, 'e2e_purge_account', { p_account_id: accountId })
      expect(purged.error).toBeNull()
    }
    if (userId) await auth.auth.admin.deleteUser(userId)
  })

  it('a signed-in person creates an account: owner, sandbox, its tenant named', async () => {
    const { data, error } = await asUser.rpc('create_account', { p_name: `DB test ${stamp}` })
    expect(error).toBeNull()
    const created = z
      .object({ ok: z.literal(true), accountId: z.uuid(), shortId: z.string() })
      .parse(data)
    accountId = created.accountId
    shortId = created.shortId
    const { data: account } = await asUser
      .from('accounts')
      .select('state, plan_code, ses_tenant, config_set')
      .eq('id', accountId)
      .single()
    expect(account).toEqual({
      state: 'sandbox',
      plan_code: 'free',
      ses_tenant: `mdm-${shortId}`,
      config_set: `mdm-${shortId}`,
    })
  })

  it('makes a key, stored only as its hash; the API finds it by that hash', async () => {
    const key = newApiKey()
    keyHash = await hashApiKey(key.key, pepper)
    const { data, error } = await asUser.rpc('create_api_key', {
      p_account_id: accountId,
      p_name: 'DB test',
      p_permission: 'full',
      p_prefix: key.prefix,
      p_key_hash: keyHash,
    })
    expect(error).toBeNull()
    ok.parse(data)
    const { data: keys } = await asUser
      .from('api_keys')
      .select('prefix, permission')
      .eq('account_id', accountId)
    expect(keys).toEqual([{ prefix: key.prefix, permission: 'full' }])

    const found = await service.rpc('authenticate_key', { p_key_hash: keyHash })
    expect(found.error).toBeNull()
    expect(found.data).toMatchObject({ ok: true, accountId, permission: 'full' })
    const wrong = await service.rpc('authenticate_key', {
      p_key_hash: await hashApiKey(newApiKey().key, pepper),
    })
    expect(sqlRefusalSchema.parse(wrong.data).code).toBe('unauthorized')
  })

  it('refuses to queue until the tenant is ready, then queues once per Idempotency-Key', async () => {
    const keyId = z
      .object({ keyId: z.uuid() })
      .parse((await service.rpc('authenticate_key', { p_key_hash: keyHash })).data).keyId
    const input = toEnqueueInput(
      sendEmailSchema.parse({
        from: `DB test <hello@${domain}>`,
        to: email,
        subject: 'Mail send path check',
        text: 'This email is never sent.',
        tags: [{ name: 'kind', value: 'db_test' }],
      }),
    )
    const enqueue = async () =>
      service.rpc('enqueue_email', {
        p_account_id: accountId,
        p_api_key_id: keyId,
        p_email: input.email,
        p_payload: input.payload,
        p_idempotency_key: `db-test-${stamp}`,
        p_request_hash: await requestHash(input),
      })

    expect(sqlRefusalSchema.parse((await enqueue()).data).code).toBe('account_not_ready')

    const ready = await call(service, 'e2e_ready_account', {
      p_account_id: accountId,
      p_domain: domain,
    })
    expect(ready.error).toBeNull()
    ok.parse(ready.data)

    const first = await enqueue()
    expect(first.error).toBeNull()
    const queued = z
      .object({
        ok: z.literal(true),
        id: z.uuid(),
        status: z.literal('queued'),
        replayed: z.literal(false),
      })
      .parse(first.data)
    emailId = queued.id
    const again = await enqueue()
    expect(again.data).toEqual({ ok: true, id: emailId, status: 'queued', replayed: true })
  })

  it('the worker claims it with its tenant and body, and records SES’s message id', async () => {
    const claimed = await call(service, 'claim_sends', {
      p_worker: worker,
      p_limit: 10,
      p_paid_only: false,
      p_account_id: accountId,
    })
    expect(claimed.error).toBeNull()
    const rows = z.array(claimedEmailSchema).parse(claimed.data)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({
      publicId: emailId,
      accountShortId: shortId,
      tenant: `mdm-${shortId}`,
      configurationSet: `mdm-${shortId}`,
      from: `DB test <hello@${domain}>`,
      to: [email],
      recipientCount: 1,
      attempt: 1,
      text: 'This email is never sent.',
      tags: [{ name: 'kind', value: 'db_test' }],
    })

    const store = createMailStore(service)
    if (!row) throw new Error('no row')
    expect(await store.record(row.id, 'another-worker', { outcome: 'sent', messageId: 'x' })).toBe(
      false,
    )
    expect(
      await store.record(row.id, worker, { outcome: 'sent', messageId: `db-test-${stamp}` }),
    ).toBe(true)

    const view = await service.rpc('get_email', { p_account_id: accountId, p_public_id: emailId })
    expect(view.data).toMatchObject({ id: emailId, status: 'sent', to: [email] })
    expect(view.data).not.toHaveProperty('text')
    const { data: usage } = await asUser
      .from('usage_daily')
      .select('queued, sent')
      .eq('account_id', accountId)
    expect(usage).toEqual([{ queued: 1, sent: 1 }])
  })
})
