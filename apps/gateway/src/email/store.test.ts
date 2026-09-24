import type { Database } from '@dr/db'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createEmailStore } from './store'

/** Records what the store sends; the functions themselves are in email.db.test.ts. */
function fakeClient(answer: { data?: unknown; error?: { message: string } } = {}) {
  const calls: { fn: string; args: unknown }[] = []
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })
    },
  }
  return { client: client as unknown as SupabaseClient<Database>, calls }
}

describe('email store', () => {
  it('claims one side’s due emails for this worker', async () => {
    const { client, calls } = fakeClient({
      data: [
        {
          id: 'e1',
          kind: 'order_receipt',
          category: 'transactional',
          to_email: 'ada@gmail.com',
          data: { order_number: 'ND-1' },
          attempts: 1,
          test_mode: false,
          user_id: 'u1',
          domain_id: null,
          order_id: 'o1',
        },
      ],
    })
    const claimed = await createEmailStore(client).claim('gw-1', false, 10)
    expect(calls).toEqual([
      { fn: 'claim_emails', args: { p_worker: 'gw-1', p_test_mode: false, p_limit: 10 } },
    ])
    expect(claimed).toEqual([
      {
        id: 'e1',
        kind: 'order_receipt',
        toEmail: 'ada@gmail.com',
        data: { order_number: 'ND-1' },
        attempts: 1,
        testMode: false,
      },
    ])
  })

  it('records sent, failed and skipped, fenced by the worker', async () => {
    const { client, calls } = fakeClient({ data: true })
    const store = createEmailStore(client)
    expect(await store.sent('e1', 'gw-1', '<m1>', 'order_receipt@1')).toBe(true)
    expect(await store.failed('e1', 'gw-1', 'HTTP 503', false)).toBe(true)
    expect(await store.skipped('e1', 'gw-1', 'reserved_address')).toBe(true)
    await store.sent('e2', 'gw-1', null, 'x@1')
    expect(calls.map((call) => call.fn)).toEqual([
      'mark_email_sent',
      'mark_email_failed',
      'mark_email_skipped',
      'mark_email_sent',
    ])
    expect(calls[0]?.args).toEqual({
      p_id: 'e1',
      p_worker: 'gw-1',
      p_message_id: '<m1>',
      p_template_version: 'order_receipt@1',
    })
    expect(calls[3]?.args).toMatchObject({ p_message_id: '' })
  })

  it('lists sent notices due a delivery check, and records the answer', async () => {
    const { client, calls } = fakeClient({
      data: [
        { id: 'e1', provider_message_id: '<m1>', sent_at: '2026-09-24T07:05:00Z' },
        { id: 'e2', provider_message_id: null, sent_at: '2026-09-24T07:05:00Z' },
      ],
    })
    const store = createEmailStore(client)
    expect(await store.deliveryDue(50)).toEqual([
      { id: 'e1', messageId: '<m1>', sentAt: new Date('2026-09-24T07:05:00Z') },
    ])
    await store.recordDelivery('e1', 'bounced')
    expect(calls.at(-1)).toEqual({
      fn: 'record_email_delivery',
      args: { p_id: 'e1', p_status: 'bounced' },
    })
  })

  it('throws on a database error, so nothing is assumed', async () => {
    const store = createEmailStore(fakeClient({ error: { message: 'permission denied' } }).client)
    await expect(store.claim('gw-1', false, 10)).rejects.toThrow('permission denied')
    await expect(store.sent('e1', 'gw-1', 'm', 'v')).rejects.toThrow('permission denied')
    await expect(store.deliveryDue(10)).rejects.toThrow('permission denied')
    await expect(store.recordDelivery('e1', null)).rejects.toThrow('permission denied')
  })
})
