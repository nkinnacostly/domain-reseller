import { describe, expect, it } from 'vitest'
import { createMailStore, type MailClient, StoreError } from './store'

/** Records what the store sends; the functions themselves are proven in supabase/tests/mail_sending.sql. */
function fakeClient(answer: { data?: unknown; error?: { code: string } } = {}) {
  const calls: { schema: string; fn: string; args: unknown }[] = []
  const rpc = (schema: string) => (fn: string, args: unknown) => {
    calls.push({ schema, fn, args })
    return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })
  }
  const client = { rpc: rpc('mail'), schema: (name: string) => ({ rpc: rpc(name) }) }
  return { client: client as unknown as MailClient, calls }
}

const ROW = {
  id: 41,
  publicId: '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d',
  accountShortId: '0a1b2c3d4e',
  tenant: 'mdm-0a1b2c3d4e',
  configurationSet: 'mdm-0a1b2c3d4e',
  from: 'Acme <receipts@acme.example>',
  to: ['ada@example.com'],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Your receipt',
  tags: [],
  recipientCount: 1,
  attempt: 1,
  html: '<p>Thanks!</p>',
  text: null,
  headers: {},
  attachments: [],
}

describe('the worker’s store', () => {
  it('claims for this worker, paid accounts only when asked', async () => {
    const { client, calls } = fakeClient({ data: [ROW] })
    expect(await createMailStore(client).claim('w-1', 10, true)).toEqual([ROW])
    expect(calls).toEqual([
      {
        schema: 'mail',
        fn: 'claim_sends',
        args: { p_worker: 'w-1', p_limit: 10, p_paid_only: true },
      },
    ])
  })

  it('keeps the id of a row it cannot read, so it can be failed; refuses an answer with none', async () => {
    const { client } = fakeClient({ data: [{ id: 9, from: 42 }] })
    expect(await createMailStore(client).claim('w-1', 10, false)).toEqual([
      { id: 9, unreadable: true },
    ])
    await expect(
      createMailStore(fakeClient({ data: [{}] }).client).claim('w-1', 1, false),
    ).rejects.toThrow(StoreError)
    await expect(
      createMailStore(fakeClient({ data: { not: 'a list' } }).client).claim('w-1', 1, false),
    ).rejects.toThrow('unexpected_answer')
    await expect(
      createMailStore(fakeClient({ error: { code: 'PGRST301' } }).client).claim('w-1', 1, false),
    ).rejects.toThrow('PGRST301')
  })

  it('records each outcome with only the arguments it needs', async () => {
    const { client, calls } = fakeClient({ data: { ok: true } })
    const store = createMailStore(client)
    expect(await store.record(41, 'w-1', { outcome: 'sent', messageId: '0102-m1' })).toBe(true)
    await store.record(41, 'w-1', {
      outcome: 'throttled',
      code: 'Throttling',
      retryAfterSeconds: 2,
    })
    await store.record(41, 'w-1', { outcome: 'retry', code: null })
    await store.record(41, 'w-1', { outcome: 'failed', code: 'MessageRejected' })
    expect(calls.map((call) => call.args)).toEqual([
      { p_email_id: 41, p_worker: 'w-1', p_outcome: 'sent', p_message_id: '0102-m1' },
      {
        p_email_id: 41,
        p_worker: 'w-1',
        p_outcome: 'throttled',
        p_error_code: 'Throttling',
        p_retry_after_seconds: 2,
      },
      { p_email_id: 41, p_worker: 'w-1', p_outcome: 'retry' },
      { p_email_id: 41, p_worker: 'w-1', p_outcome: 'failed', p_error_code: 'MessageRejected' },
    ])
  })

  it('reports a claim that moved on, and refuses what it cannot read', async () => {
    expect(
      await createMailStore(fakeClient({ data: { ok: false, code: 'not_claimed' } }).client).record(
        1,
        'w',
        { outcome: 'retry', code: null },
      ),
    ).toBe(false)
    await expect(
      createMailStore(fakeClient({ data: 'odd' }).client).record(1, 'w', {
        outcome: 'retry',
        code: null,
      }),
    ).rejects.toThrow('unexpected_answer')
    await expect(
      createMailStore(fakeClient({ error: { code: '57014' } }).client).record(1, 'w', {
        outcome: 'retry',
        code: null,
      }),
    ).rejects.toThrow('57014')
  })

  it('beats in the shop’s heartbeat table, as a live service', async () => {
    const { client, calls } = fakeClient()
    await createMailStore(client).heartbeat('mail-worker:send', { sent: 3 })
    expect(calls).toEqual([
      {
        schema: 'public',
        fn: 'record_heartbeat',
        args: { p_name: 'mail-worker:send', p_test_mode: false, p_detail: { sent: 3 } },
      },
    ])
    await expect(
      createMailStore(fakeClient({ error: { code: '42501' } }).client).heartbeat('x', {}),
    ).rejects.toThrow('42501')
  })
})
