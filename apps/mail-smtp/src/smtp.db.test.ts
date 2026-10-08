import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Database, Json } from '@dr/db'
import { hashApiKey, newApiKey } from '@dr/shared/mail'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRelay } from './relay'
import { createRelayStore, type MailClient } from './store'

/**
 * The relay against the hosted database, through PostgREST with the real
 * keys and grants: a person makes an account and a key; Nodemailer signs in
 * to the relay with that key and sends; enqueue_email queues it — once, for
 * a retry — and the payload holds the inline image as one. No email is
 * sent: the account is a test account (an e2e-*@example.com member), its
 * domain is under the reserved `.example` TLD, and the worker's own claim
 * never takes a test account's email.
 *
 *   DB_TESTS=1 pnpm --filter @dr/mail-smtp exec vitest run src/smtp.db.test.ts
 *
 * Its user and account are purged afterwards (e2e_purge_account). It reads
 * the root .env itself and never prints a key or the pepper.
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

const call = (client: MailClient, fn: string, args: object) =>
  (
    client.rpc as unknown as (
      fn: string,
      args: object,
    ) => PromiseLike<{ data: Json; error: { code?: string } | null }>
  )(fn, args)

const ok = z.looseObject({ ok: z.literal(true) })
const silent = { info() {}, warn() {}, error() {} }

describe.skipIf(!enabled)('the SMTP relay against the database', () => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const email = `e2e-smtp-${stamp}@example.com`
  const password = `e2e-${stamp}-Pw-9`
  const domain = `s${stamp}.e2e.example`

  let auth: SupabaseClient<Database>
  let service: MailClient
  let userId = ''
  let accountId = ''
  let key = ''
  let port = 0
  let close: () => Promise<void> = async () => undefined

  beforeAll(async () => {
    const env = readEnv()
    const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    const secret = env.SUPABASE_SECRET_KEY ?? ''
    const pepper = env.MAIL_API_KEY_PEPPER ?? ''
    if (!url || !secret || !pepper || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
      throw new Error('the root .env needs the Supabase URL and keys and MAIL_API_KEY_PEPPER')
    }
    const options = { auth: { persistSession: false, autoRefreshToken: false } }
    auth = createClient<Database>(url, secret, options)
    service = createClient<Database, 'mail'>(url, secret, { ...options, db: { schema: 'mail' } })
    const asUser = createClient<Database, 'mail'>(url, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      ...options,
      db: { schema: 'mail' },
    })

    const created = await auth.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error || !created.data.user) throw new Error(created.error?.message ?? 'no user')
    userId = created.data.user.id
    const signedIn = await asUser.auth.signInWithPassword({ email, password })
    if (signedIn.error) throw new Error(signedIn.error.message)
    const account = await asUser.rpc('create_account', { p_name: `SMTP test ${stamp}` })
    accountId = z.object({ accountId: z.uuid() }).parse(account.data).accountId
    ok.parse(
      (await call(service, 'e2e_ready_account', { p_account_id: accountId, p_domain: domain }))
        .data,
    )
    const made = newApiKey()
    key = made.key
    ok.parse(
      (
        await asUser.rpc('create_api_key', {
          p_account_id: accountId,
          p_name: 'SMTP test',
          p_permission: 'sending',
          p_prefix: made.prefix,
          p_key_hash: await hashApiKey(made.key, pepper),
        })
      ).data,
    )
    await asUser.auth.signOut({ scope: 'local' })

    const { server } = createRelay({
      store: createRelayStore(service),
      pepper,
      log: silent,
      hostname: 'smtp.mydomainshub.test',
      maxClients: 5,
      relayId: `db-test:${stamp}`,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.server.address() as AddressInfo).port
    close = () => new Promise((resolve) => server.close(() => resolve()))
  })

  afterAll(async () => {
    await close()
    if (accountId) {
      const purged = await call(service, 'e2e_purge_account', { p_account_id: accountId })
      expect(purged.error).toBeNull()
    }
    if (userId) await auth.auth.admin.deleteUser(userId)
  })

  const transport = (pass = key) =>
    nodemailer.createTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      ignoreTLS: true,
      auth: { user: 'mydomainshub', pass },
    })

  const message = {
    from: `SMTP test <hello@${domain}>`,
    to: email,
    subject: 'SMTP relay check',
    text: 'This email is never sent.',
    html: '<p>Never sent.</p><img src="cid:logo">',
    messageId: `<smtp-${stamp}@${domain}>`,
    headers: { 'X-Entity-Ref-ID': stamp },
    attachments: [
      { filename: 'logo.png', content: Buffer.from('png'), contentType: 'image/png', cid: 'logo' },
      {
        filename: 'receipt.pdf',
        content: Buffer.from('%PDF-1.4\n'),
        contentType: 'application/pdf',
      },
    ],
  }

  let emailId = ''

  it('queues what Nodemailer sends, with the inline image as one, and a retry once', async () => {
    const first = await transport().sendMail(message)
    emailId = /Queued as ([0-9a-f-]{36})$/.exec(first.response)?.[1] ?? ''
    expect(emailId).not.toBe('')
    const again = await transport().sendMail(message)
    expect(again.response).toBe(first.response)

    const view = await service.rpc('get_email', { p_account_id: accountId, p_public_id: emailId })
    expect(view.data).toMatchObject({ to: [email], subject: 'SMTP relay check', status: 'queued' })
    // What the worker will receive: claimed for this test account only, as e2e does.
    const claimed = await call(service, 'claim_sends', {
      p_worker: `db-test:${stamp}`,
      p_limit: 5,
      p_paid_only: false,
      p_account_id: accountId,
    })
    expect(claimed.error).toBeNull()
    const mine = (claimed.data as { publicId: string }[]).find((one) => one.publicId === emailId)
    expect(mine).toMatchObject({
      headers: { 'X-Entity-Ref-ID': stamp },
      attachments: [
        { filename: 'logo.png', content_type: 'image/png', content_id: 'logo' },
        { filename: 'receipt.pdf', content_type: 'application/pdf' },
      ],
    })
  })

  it('refuses a stranger as the sandbox does, and a wrong key at AUTH', async () => {
    await expect(
      transport().sendMail({ ...message, to: 'stranger@example.com', messageId: undefined }),
    ).rejects.toMatchObject({
      responseCode: 550,
      response: expect.stringContaining('sandbox'),
    })
    await expect(transport(newApiKey().key).sendMail(message)).rejects.toMatchObject({
      responseCode: 535,
    })
  })
})
