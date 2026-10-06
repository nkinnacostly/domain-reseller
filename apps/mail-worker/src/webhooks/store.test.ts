import { describe, expect, it } from 'vitest'
import { type MailClient, StoreError } from '../store'
import { createWebhookStore } from './store'

/** What the webhook store sends; the functions themselves are proven in supabase/tests/mail_events.sql. */
function fakeClient(answer: { data?: unknown; error?: { code: string } } = {}) {
  const calls: { fn: string; args: unknown }[] = []
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })
    },
  }
  return { client: client as unknown as MailClient, calls }
}

const CLAIMED = {
  id: 7,
  webhookId: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f',
  accountId: '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e',
  url: 'https://hooks.acme.example/mdh',
  secretSealed: `v1.${'A'.repeat(16)}.${'B'.repeat(72)}`,
  messageId: `msg_${'a'.repeat(32)}`,
  eventType: 'email.delivered',
  payload: { type: 'email.delivered', created_at: '2026-10-06T08:00:00.000Z', data: {} },
  attempt: 1,
}

describe('the webhook store', () => {
  it('claims for this worker, and for one test account when asked', async () => {
    const { client, calls } = fakeClient({ data: [CLAIMED] })
    const store = createWebhookStore(client)
    expect(await store.claim('w-1', 20)).toEqual([CLAIMED])
    await store.claim('w-1', 5, CLAIMED.accountId)
    expect(calls).toEqual([
      { fn: 'claim_webhook_deliveries', args: { p_worker: 'w-1', p_limit: 20 } },
      {
        fn: 'claim_webhook_deliveries',
        args: { p_worker: 'w-1', p_limit: 5, p_account_id: CLAIMED.accountId },
      },
    ])
  })

  it('keeps the id of a row it cannot read; refuses an answer with none', async () => {
    expect(
      await createWebhookStore(fakeClient({ data: [{ id: 9, url: 4 }] }).client).claim('w', 1),
    ).toEqual([{ id: 9, unreadable: true }])
    await expect(
      createWebhookStore(fakeClient({ data: [{ url: 4 }] }).client).claim('w', 1),
    ).rejects.toThrow(StoreError)
    await expect(
      createWebhookStore(fakeClient({ data: { no: 'array' } }).client).claim('w', 1),
    ).rejects.toThrow('unexpected_answer')
    await expect(
      createWebhookStore(fakeClient({ error: { code: '57014' } }).client).claim('w', 1),
    ).rejects.toThrow('57014')
  })

  it('records an answer with only what it has', async () => {
    const { client, calls } = fakeClient({ data: { ok: true, status: 'delivered' } })
    const store = createWebhookStore(client)
    expect(
      await store.record(7, 'w-1', { status: 204, error: null, response: 'ok', durationMs: 120 }),
    ).toBe(true)
    await store.record(7, 'w-1', {
      status: null,
      error: 'timeout',
      response: null,
      durationMs: null,
    })
    expect(calls.map((call) => call.args)).toEqual([
      {
        p_delivery_id: 7,
        p_worker: 'w-1',
        p_status_code: 204,
        p_response: 'ok',
        p_duration_ms: 120,
      },
      { p_delivery_id: 7, p_worker: 'w-1', p_error: 'timeout' },
    ])
  })

  it('says when the claim had passed on, and throws when the database could not be asked', async () => {
    const attempt = { status: 500, error: null, response: null, durationMs: 3 }
    expect(
      await createWebhookStore(
        fakeClient({ data: { ok: false, code: 'not_claimed' } }).client,
      ).record(1, 'w', attempt),
    ).toBe(false)
    await expect(
      createWebhookStore(fakeClient({ error: { code: '08006' } }).client).record(1, 'w', attempt),
    ).rejects.toThrow('record_webhook_attempt')
    await expect(
      createWebhookStore(fakeClient({ data: 'what' }).client).record(1, 'w', attempt),
    ).rejects.toThrow('unexpected_answer')
  })
})
