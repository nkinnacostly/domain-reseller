import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from '@dr/db'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEmailStore, type EmailStore } from './store'

/**
 * Migration 31's email functions, called for real against the hosted
 * project through the gateway's store and the web's two entry points.
 *
 *   DB_TESTS=1 pnpm --filter @dr/gateway exec vitest run src/email/email.db.test.ts
 *
 * Its throwaway e2e-* user lives at example.com, so every email it causes is
 * queued as skipped and can never be sent — by this test or by a deployed
 * gateway. The sending path itself is checked in supabase/tests/notification_emails.sql.
 */

const enabled = process.env.DB_TESTS === '1'

function readEnv(): Record<string, string> {
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url))
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

describe.skipIf(!enabled)('email outbox against the database', () => {
  let db: SupabaseClient<Database>
  let store: EmailStore
  let userId = ''
  let domainId = ''
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

  const outbox = async () => {
    const { data } = await db
      .from('email_outbox')
      .select('kind, category, status, skip_reason, test_mode, data')
      .eq('user_id', userId)
      .order('created_at')
    return data ?? []
  }

  beforeAll(async () => {
    const env = readEnv()
    db = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL ?? '', env.SUPABASE_SECRET_KEY ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    store = createEmailStore(db)
    const { data: user, error } = await db.auth.admin.createUser({
      email: `e2e-email-${stamp}@example.com`,
      password: `e2e-${stamp}-Pw-9`,
      email_confirm: true,
    })
    if (error || !user.user) throw new Error(error?.message ?? 'no user')
    userId = user.user.id
  })

  afterAll(async () => {
    if (domainId) await db.from('domains').delete().eq('id', domainId)
    if (userId) await db.auth.admin.deleteUser(userId)
  })

  it('remembers the first device quietly and queues a notice for the second (SEC-4)', async () => {
    const first = await db.rpc('note_sign_in', { p_user_id: userId, p_device: 'Chrome on macOS' })
    const second = await db.rpc('note_sign_in', { p_user_id: userId, p_device: 'Safari on iOS' })
    expect([first.error, second.error]).toEqual([null, null])
    expect([first.data, second.data]).toEqual([false, true])
    expect(await outbox()).toEqual([
      expect.objectContaining({
        kind: 'new_sign_in',
        category: 'security',
        status: 'skipped',
        skip_reason: 'reserved_address',
      }),
    ])
  })

  it('queues password and two-factor notices, and refuses anything else', async () => {
    expect(
      (await db.rpc('queue_account_email', { p_user_id: userId, p_kind: 'password_changed' }))
        .error,
    ).toBeNull()
    const wrong = await db.rpc('queue_account_email', {
      p_user_id: userId,
      p_kind: 'order_receipt',
    })
    expect(wrong.error?.message).toMatch(/not an account email/)
    expect((await outbox()).map((row) => row.kind)).toEqual(['new_sign_in', 'password_changed'])
  })

  it('queues a security notice when the web records a transfer-code view', async () => {
    const { data, error } = await db
      .from('domains')
      .insert({
        user_id: userId,
        domain_name: `e2eemail${stamp}.com`,
        tld: 'com',
        source: 'registration',
        local_status: 'active',
        test_mode: true,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    domainId = data.id
    await db.from('domain_events').insert({
      domain_id: domainId,
      event_type: 'auth_code_revealed',
      actor_type: 'user',
      payload: {},
    })
    expect((await outbox()).at(-1)).toMatchObject({
      kind: 'auth_code_revealed',
      category: 'security',
      test_mode: true,
      data: { domain: `e2eemail${stamp}.com` },
    })
  })

  it('never hands a skipped email to a sender', async () => {
    const claimed = await store.claim(`db-test-${stamp}`, true, 50)
    expect(claimed.filter((email) => email.toEmail.includes(stamp))).toEqual([])
    const due = await store.deliveryDue(200)
    expect(Array.isArray(due)).toBe(true)
    // Only a sent email can have a delivery recorded.
    const { data: row } = await db
      .from('email_outbox')
      .select('id')
      .eq('user_id', userId)
      .limit(1)
      .single()
    await expect(store.recordDelivery(row?.id ?? '', 'delivered')).resolves.toBeUndefined()
    expect(await store.sent(row?.id ?? '', `db-test-${stamp}`, 'm', 'v@1')).toBe(false)
  })
})
