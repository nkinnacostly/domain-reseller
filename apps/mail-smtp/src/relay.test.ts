import type { AddressInfo } from 'node:net'
import { hashApiKey, type SqlRefusal } from '@dr/shared/mail'
import nodemailer from 'nodemailer'
import type Mail from 'nodemailer/lib/mailer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SMTP_LIMITS } from './message'
import { createRelay } from './relay'
import type { EnqueueAnswer, KeyAnswer, RelayStore } from './store'

/**
 * The relay end to end on a real socket, as a mail program meets it:
 * Nodemailer — what Node apps and many frameworks send with — signs in with
 * an API key and sends. The store is a fake that records what would reach
 * SQL; SQL's own rules are proven by supabase/tests/mail_sending.sql.
 */

const KEY = `mdh_live_${'5mtpK3y0'.repeat(5)}`
const PEPPER = 'test pepper, not a secret, 0123456789'
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const KEY_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const EMAIL_ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'

const KEY_OK: KeyAnswer = {
  ok: true,
  key: { keyId: KEY_ID, accountId: ACCOUNT, permission: 'sending', domainId: null },
}
const QUEUED: EnqueueAnswer = { ok: true, id: EMAIL_ID, status: 'queued', replayed: false }

type Calls = { auth: string[]; enqueue: Parameters<RelayStore['enqueueEmail']>[0][] }

function fakeStore({
  auth = () => KEY_OK,
  enqueue = () => QUEUED,
}: {
  auth?: (call: number) => KeyAnswer | Promise<KeyAnswer>
  enqueue?: () => EnqueueAnswer | Promise<EnqueueAnswer>
} = {}) {
  const calls: Calls = { auth: [], enqueue: [] }
  const store: RelayStore = {
    async authenticateKey(hash) {
      calls.auth.push(hash)
      return auth(calls.auth.length)
    },
    async enqueueEmail(input) {
      calls.enqueue.push(input)
      return enqueue()
    },
    heartbeat: vi.fn(async () => undefined),
  }
  return { store, calls }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const servers: { close(cb: () => void): void }[] = []

async function relay(store: RelayStore) {
  const { server, counts } = createRelay({
    store,
    pepper: PEPPER,
    log,
    hostname: 'smtp.mydomainshub.test',
    maxClients: 10,
    relayId: 'test-relay',
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.server.address() as AddressInfo
  return { port, counts }
}

function client(port: number, pass = KEY, extra: object = {}) {
  return nodemailer.createTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user: 'mydomainshub', pass },
    ...extra,
  })
}

const MESSAGE: Mail.Options = {
  from: 'Acme <receipts@acme.example>',
  to: 'Ada Obi <ada@example.com>',
  subject: 'Your receipt',
  text: 'Thanks for your order.',
  messageId: '<order-1042@acme.example>',
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(r))))
})

describe('sending through the relay', () => {
  it('signs in with the key, queues the email as the API would, and answers its id', async () => {
    const { store, calls } = fakeStore()
    const { port, counts } = await relay(store)
    const info = await client(port).sendMail({ ...MESSAGE, bcc: 'audit@acme.example' })

    expect(info.response).toBe(`250 2.0.0 Queued as ${EMAIL_ID}`)
    expect(calls.auth).toEqual([await hashApiKey(KEY, PEPPER)])
    expect(calls.enqueue).toHaveLength(1)
    const [queued] = calls.enqueue
    expect(queued).toMatchObject({
      accountId: ACCOUNT,
      keyId: KEY_ID,
      idempotencyKey: expect.stringMatching(/^smtp-[0-9a-f]{64}$/),
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      email: {
        email: {
          from: 'Acme <receipts@acme.example>',
          to: ['Ada Obi <ada@example.com>'],
          bcc: ['audit@acme.example'],
          subject: 'Your receipt',
        },
        // SMTP ends the data with a line break; the body keeps it, as written.
        payload: { text: 'Thanks for your order.\n', html: null },
      },
    })
    expect(counts()).toMatchObject({ accepted: 1, refused: 0 })
    // Ids and counts reach the log; never an address, the subject or the key (N13).
    const logged = JSON.stringify(log.info.mock.calls)
    expect(logged).toContain(EMAIL_ID)
    expect(logged).not.toMatch(/@|Your receipt|mdh_live_/)
  })

  it('charges every email after the first to the key, and notices a key revoked meanwhile', async () => {
    const { store, calls } = fakeStore({
      auth: (n) => (n < 3 ? KEY_OK : ({ ok: false, code: 'unauthorized' } as SqlRefusal)),
    })
    const { port } = await relay(store)
    const transport = client(port, KEY, { pool: true, maxConnections: 1 })
    await transport.sendMail(MESSAGE)
    await transport.sendMail({ ...MESSAGE, messageId: '<second@acme.example>' })
    await expect(
      transport.sendMail({ ...MESSAGE, messageId: '<third@acme.example>' }),
    ).rejects.toMatchObject({
      responseCode: 535,
    })
    transport.close()
    // One AUTH, then one check for each email after the first.
    expect(calls.auth).toHaveLength(3)
    expect(calls.enqueue).toHaveLength(2)
  })
})

describe('refused at the door', () => {
  it('a password that is not an API key is refused without asking the database', async () => {
    const { store, calls } = fakeStore()
    const { port } = await relay(store)
    await expect(client(port, 'hunter2').sendMail(MESSAGE)).rejects.toMatchObject({
      code: 'EAUTH',
      responseCode: 535,
      response: expect.stringContaining('5.7.8'),
    })
    expect(calls.auth).toHaveLength(0)
  })

  it('a key SQL refuses is 535; a busy key is 451, a database that does not answer 454', async () => {
    const refused = fakeStore({ auth: () => ({ ok: false, code: 'unauthorized' }) })
    await expect(client((await relay(refused.store)).port).sendMail(MESSAGE)).rejects.toMatchObject(
      {
        responseCode: 535,
      },
    )
    const busy = fakeStore({
      auth: () => ({ ok: false, code: 'rate_limited', retryAfterMs: 2000 }),
    })
    await expect(client((await relay(busy.store)).port).sendMail(MESSAGE)).rejects.toMatchObject({
      responseCode: 451,
      response: expect.stringContaining('Too many requests'),
    })
    const down = fakeStore({
      auth: () => {
        throw new Error('fetch failed')
      },
    })
    await expect(client((await relay(down.store)).port).sendMail(MESSAGE)).rejects.toMatchObject({
      responseCode: 454,
    })
  })

  it('takes nothing before AUTH', async () => {
    const { store } = fakeStore()
    const { port } = await relay(store)
    const transport = nodemailer.createTransport({
      host: '127.0.0.1',
      port,
      secure: false,
      ignoreTLS: true,
    })
    await expect(transport.sendMail(MESSAGE)).rejects.toMatchObject({ responseCode: 530 })
  })

  it('takes 50 recipients and refuses the 51st', async () => {
    const { store, calls } = fakeStore()
    const { port } = await relay(store)
    const bcc = Array.from({ length: SMTP_LIMITS.maxRecipients }, (_, i) => `r${i}@example.com`)
    const info = await client(port).sendMail({ ...MESSAGE, bcc })
    expect(info.rejected).toEqual([bcc.at(-1)])
    expect(calls.enqueue[0]?.email.email.bcc).toHaveLength(SMTP_LIMITS.maxRecipients - 1)
  })

  it('refuses a message over the size limit', async () => {
    const { store, calls } = fakeStore()
    const { port } = await relay(store)
    await expect(
      client(port).sendMail({
        ...MESSAGE,
        attachments: [{ filename: 'big.bin', content: Buffer.alloc(SMTP_LIMITS.maxMessageBytes) }],
      }),
    ).rejects.toMatchObject({ responseCode: 552, response: expect.stringContaining('5.3.4') })
    expect(calls.enqueue).toHaveLength(0)
  })
})

describe('refused as the API refuses', () => {
  const refusedBy = async (enqueue: () => EnqueueAnswer, message: Mail.Options = MESSAGE) => {
    const { store, calls } = fakeStore({ enqueue })
    const { port, counts } = await relay(store)
    const error = await client(port)
      .sendMail(message)
      .then(
        () => null,
        (e: { responseCode: number; response: string }) => e,
      )
    return { error, calls, counts: counts() }
  }

  it('says why in the API’s words, final (5xx) or try-later (4xx) as each is', async () => {
    const domain = await refusedBy(() => ({ ok: false, code: 'domain_not_verified' }))
    expect(domain.error).toMatchObject({
      responseCode: 550,
      response: expect.stringMatching(/^550 5\.7\.1 The from address’s domain is not verified/),
    })
    expect(domain.counts.refused).toBe(1)

    const today = await refusedBy(() => ({
      ok: false,
      code: 'quota_exceeded',
      scope: 'day',
      cap: 350,
    }))
    expect(today.error).toMatchObject({
      responseCode: 451,
      response: expect.stringContaining('350 emails for today'),
    })
    const month = await refusedBy(() => ({
      ok: false,
      code: 'quota_exceeded',
      scope: 'month',
      cap: 10500,
    }))
    expect(month.error).toMatchObject({ responseCode: 550 })
    const sandbox = await refusedBy(() => ({ ok: false, code: 'sandbox_recipient' }))
    expect(sandbox.error).toMatchObject({
      responseCode: 550,
      response: expect.stringContaining('sandbox'),
    })
  })

  it('refuses what the API’s schema and content checks refuse, before SQL', async () => {
    const executable = await refusedBy(() => QUEUED, {
      ...MESSAGE,
      attachments: [{ filename: 'setup.exe', content: Buffer.from('MZ') }],
    })
    expect(executable.error).toMatchObject({
      responseCode: 550,
      response: expect.stringContaining('5.6.0 attachments[0].filename: Executable attachments'),
    })
    const shortener = await refusedBy(() => QUEUED, {
      ...MESSAGE,
      text: 'Pay here: https://bit.ly/x',
    })
    expect(shortener.error).toMatchObject({
      responseCode: 550,
      response: expect.stringContaining('5.7.1'),
    })
    expect([...executable.calls.enqueue, ...shortener.calls.enqueue]).toHaveLength(0)
  })

  it('a message without a To recipient in the envelope, or a failing database', async () => {
    const onlyBcc = await refusedBy(() => QUEUED, {
      ...MESSAGE,
      to: undefined,
      bcc: 'ada@example.com',
    })
    expect(onlyBcc.error).toMatchObject({
      responseCode: 550,
      response: expect.stringContaining('To header'),
    })
    const down = await refusedBy(() => {
      throw new Error('fetch failed')
    })
    expect(down.error).toMatchObject({
      responseCode: 451,
      response: expect.stringContaining('4.3.0'),
    })
    expect(log.error).toHaveBeenCalled()
  })
})
