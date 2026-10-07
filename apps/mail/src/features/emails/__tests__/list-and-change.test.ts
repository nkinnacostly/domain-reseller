import { decodeCursor, encodeCursor } from '@dr/shared/mail'
import { describe, expect, it } from 'vitest'
import { POST as CANCEL } from '@/app/api/v1/emails/[id]/cancel/route'
import { PATCH } from '@/app/api/v1/emails/[id]/route'
import { GET as LIST } from '@/app/api/v1/emails/route'
import { mockRpc } from '../../../../tests/mocks/supabase'

/**
 * GET /api/v1/emails, PATCH /api/v1/emails/{id} and POST …/cancel (§3.1,
 * §6): what reaches SQL (migration 48) and how its answers become the API's.
 */

const KEY = `mdh_live_${'L1stK3ys'.repeat(5)}`
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const EMAIL_ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'
const FULL = {
  ok: true,
  keyId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  accountId: ACCOUNT,
  permission: 'full',
  domainId: null,
}
const SENDING = { ...FULL, permission: 'sending' }

const ROW = {
  id: EMAIL_ID,
  from: 'a@acme.example',
  to: ['ada@example.com'],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: 'Your receipt',
  tags: [],
  status: 'sent',
  status_reason: null,
  created_at: '2026-10-06T09:30:00.123456Z',
  scheduled_at: '2026-10-06T09:30:00.123456Z',
  sent_at: '2026-10-06T09:30:02.000000Z',
  delivered_at: null,
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
  last_event: 'send',
  last_event_at: '2026-10-06T09:30:02.000000Z',
}

const auth = { authorization: `Bearer ${KEY}` }
const list = (query = '') =>
  LIST(new Request(`http://localhost:3001/api/v1/emails${query}`, { headers: auth }))
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost:3001/api/v1/emails/${id}`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id),
  )
const cancel = (id: string) =>
  CANCEL(
    new Request(`http://localhost:3001/api/v1/emails/${id}/cancel`, {
      method: 'POST',
      headers: auth,
    }),
    params(id),
  )

describe('GET /api/v1/emails', () => {
  it('answers a page of the account’s emails, newest first, with a cursor for the next', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      list_emails: () => ({
        ok: true,
        data: [ROW],
        hasMore: true,
        next: { at: ROW.created_at, id: EMAIL_ID },
      }),
    })
    const response = await list(
      '?limit=1&status=sent&to=ADA@example.com&tag=kind:receipt&subject=receipt',
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      object: 'list',
      has_more: true,
      data: [{ object: 'email', ...ROW }],
    })
    expect(decodeCursor(body.next_cursor)).toEqual({ at: ROW.created_at, id: EMAIL_ID })
    expect(calls[1]).toMatchObject({
      fn: 'list_emails',
      schema: 'mail',
      body: {
        p_account_id: ACCOUNT,
        p_limit: 1,
        p_filters: {
          status: 'sent',
          to: 'ada@example.com',
          tag_name: 'kind',
          tag_value: 'receipt',
          subject: 'receipt',
        },
      },
    })
    expect(calls[1]?.body).not.toHaveProperty('p_cursor_at')
  })

  it('passes the cursor back as SQL gave it, and answers the last page without one', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      list_emails: () => ({ ok: true, data: [], hasMore: false, next: null }),
    })
    const cursor = encodeCursor({ at: ROW.created_at, id: EMAIL_ID })
    const response = await list(`?cursor=${cursor}&created_after=2026-10-01T00:00:00%2B01:00`)
    expect(await response.json()).toEqual({
      object: 'list',
      data: [],
      has_more: false,
      next_cursor: null,
    })
    expect(calls[1]?.body).toMatchObject({
      p_cursor_at: ROW.created_at,
      p_cursor_id: EMAIL_ID,
      p_limit: 20,
      p_filters: { created_after: '2026-09-30T23:00:00.000Z' },
    })
  })

  it.each([
    ['an unknown filter', '?from=a@b.example', 'from'],
    ['a filter twice', '?status=sent&status=queued', 'once'],
    ['a cursor we did not give', '?cursor=bm9wZQ', 'cursor'],
    ['a limit past 100', '?limit=500', 'limit'],
  ])('refuses %s, before asking SQL', async (_, query, words) => {
    const calls = mockRpc({ authenticate_key: () => FULL })
    const response = await list(query)
    expect(response.status).toBe(422)
    expect((await response.json()).message).toContain(words)
    expect(calls).toHaveLength(1)
  })

  it('answers SQL’s own refusal in the API’s words', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      list_emails: () => ({ ok: false, code: 'validation', field: 'filters' }),
    })
    expect((await list()).status).toBe(422)
  })

  it('takes a full-access key only', async () => {
    const calls = mockRpc({ authenticate_key: () => SENDING })
    const response = await list()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ name: 'forbidden' })
    expect(calls).toHaveLength(1)
  })
})

describe('PATCH /api/v1/emails/{id}', () => {
  it('moves a waiting email, the moment in UTC', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      reschedule_email: () => ({
        ok: true,
        id: EMAIL_ID,
        status: 'queued',
        scheduledAt: '2026-10-07T09:00:00.000000Z',
      }),
    })
    const response = await patch(EMAIL_ID, { scheduled_at: '2026-10-07T10:00:00+01:00' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      object: 'email',
      id: EMAIL_ID,
      status: 'queued',
      scheduled_at: '2026-10-07T09:00:00.000000Z',
    })
    expect(calls[1]?.body).toEqual({
      p_account_id: ACCOUNT,
      p_public_id: EMAIL_ID,
      p_scheduled_at: '2026-10-07T09:00:00.000Z',
    })
  })

  it('answers 409 once the email has left the queue, naming its status', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      reschedule_email: () => ({ ok: false, code: 'not_pending', status: 'sent' }),
    })
    const response = await patch(EMAIL_ID, { scheduled_at: '2026-10-07T09:00:00Z' })
    expect(response.status).toBe(409)
    expect((await response.json()).message).toContain('its status is sent')
  })

  it('answers 429 when the new moment’s day is full: the email keeps its old one (migration 54)', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      reschedule_email: () => ({
        ok: false,
        code: 'quota_exceeded',
        scope: 'day',
        cap: 100,
        retryAfter: 3600,
      }),
    })
    const response = await patch(EMAIL_ID, { scheduled_at: '2026-10-08T09:00:00Z' })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('3600')
    expect(await response.json()).toMatchObject({ name: 'quota_exceeded' })
  })

  it('answers 404 for another account’s email, and 422 for a moment too far', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      reschedule_email: () => ({ ok: false, code: 'not_found' }),
    })
    const missing = await patch(EMAIL_ID, { scheduled_at: '2026-10-07T09:00:00Z' })
    expect(missing.status).toBe(404)
    expect((await missing.json()).message).toContain('No email with that id')
    mockRpc({
      authenticate_key: () => FULL,
      reschedule_email: () => ({ ok: false, code: 'validation', field: 'scheduled_at' }),
    })
    expect((await patch(EMAIL_ID, { scheduled_at: '2027-10-07T09:00:00Z' })).status).toBe(422)
  })

  it('refuses a body without a zoned moment, or an id that is not one, before SQL', async () => {
    const calls = mockRpc({ authenticate_key: () => FULL })
    expect((await patch(EMAIL_ID, { scheduled_at: 'tomorrow' })).status).toBe(422)
    expect((await patch(EMAIL_ID, {})).status).toBe(422)
    expect((await patch('42', { scheduled_at: '2026-10-07T09:00:00Z' })).status).toBe(404)
    expect(calls.every((call) => call.fn === 'authenticate_key')).toBe(true)
  })

  it('takes a full-access key only', async () => {
    mockRpc({ authenticate_key: () => SENDING })
    expect((await patch(EMAIL_ID, { scheduled_at: '2026-10-07T09:00:00Z' })).status).toBe(403)
  })
})

describe('POST /api/v1/emails/{id}/cancel', () => {
  it('cancels a waiting email', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      cancel_email: () => ({
        ok: true,
        id: EMAIL_ID,
        status: 'canceled',
        scheduledAt: '2026-10-07T09:00:00.000000Z',
      }),
    })
    const response = await cancel(EMAIL_ID)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ object: 'email', status: 'canceled' })
    expect(calls[1]).toMatchObject({
      fn: 'cancel_email',
      body: { p_account_id: ACCOUNT, p_public_id: EMAIL_ID },
    })
  })

  it('answers 409 for an email being sent, 404 for none, 403 for a sending key', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      cancel_email: () => ({ ok: false, code: 'not_pending', status: 'sending' }),
    })
    expect((await cancel(EMAIL_ID)).status).toBe(409)
    mockRpc({
      authenticate_key: () => FULL,
      cancel_email: () => ({ ok: false, code: 'not_found' }),
    })
    expect((await cancel(EMAIL_ID)).status).toBe(404)
    expect((await cancel('nope')).status).toBe(404)
    mockRpc({ authenticate_key: () => SENDING })
    expect((await cancel(EMAIL_ID)).status).toBe(403)
  })

  it('answers internal_error for an answer SQL never gives', async () => {
    mockRpc({ authenticate_key: () => FULL, cancel_email: () => ({ ok: true }) })
    expect((await cancel(EMAIL_ID)).status).toBe(500)
  })
})
