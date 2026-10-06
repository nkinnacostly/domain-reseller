import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/v1/emails/batch/route'
import { logger } from '@/lib/logger'
import { mockRpc } from '../../../../tests/mocks/supabase'

/**
 * POST /api/v1/emails/batch (§6): each email validated as a single send is,
 * then one SQL call that queues all or none; a refusal names its email.
 */

const KEY = `mdh_live_${'B4tchK3y'.repeat(5)}`
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const KEY_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const IDS = ['6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d', '7a2e4b63-3b1f-4a1c-8e66-1d2f3a4b5c6e']
const KEY_OK = {
  ok: true,
  keyId: KEY_ID,
  accountId: ACCOUNT,
  permission: 'sending',
  domainId: null,
}

const EMAIL = {
  from: 'Acme <receipts@acme.example>',
  to: 'ada@example.com',
  subject: 'Your receipt',
  text: 'Thanks!',
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost:3001/api/v1/emails/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  info = vi.spyOn(logger, 'info')
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/v1/emails/batch', () => {
  it('queues the batch in one call, in order, and answers an id for each', async () => {
    const calls = mockRpc({
      authenticate_key: () => KEY_OK,
      enqueue_batch: () => ({ ok: true, ids: IDS, replayed: false }),
    })
    const response = await post([
      EMAIL,
      { ...EMAIL, subject: 'Second', scheduled_at: '2026-10-07T10:00:00+01:00' },
    ])
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [{ id: IDS[0] }, { id: IDS[1] }] })
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key', 'enqueue_batch'])
    const sent = calls[1]?.body as { p_emails: { email: Record<string, unknown> }[] }
    expect(sent).toMatchObject({ p_account_id: ACCOUNT, p_api_key_id: KEY_ID })
    expect(sent.p_emails).toHaveLength(2)
    expect(sent.p_emails[0]?.email).toMatchObject({
      to: ['ada@example.com'],
      subject: 'Your receipt',
    })
    expect(sent.p_emails[0]?.email).not.toHaveProperty('scheduled_at')
    expect(sent.p_emails[1]?.email).toMatchObject({ scheduled_at: '2026-10-07T09:00:00.000Z' })
    expect(sent).not.toHaveProperty('p_idempotency_key')
  })

  it('fingerprints the whole batch for an Idempotency-Key', async () => {
    const calls = mockRpc({
      authenticate_key: () => KEY_OK,
      enqueue_batch: () => ({ ok: true, ids: IDS.slice(0, 1), replayed: true }),
    })
    const response = await post([EMAIL], { 'idempotency-key': 'nightly-receipts-1042' })
    expect(response.status).toBe(200)
    expect(calls[1]?.body).toMatchObject({
      p_idempotency_key: 'nightly-receipts-1042',
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('names the email that is not valid, without quoting it', async () => {
    const calls = mockRpc({ authenticate_key: () => KEY_OK })
    const response = await post([EMAIL, { ...EMAIL, to: 'not-an-address' }])
    expect(response.status).toBe(422)
    const { name, message } = await response.json()
    expect(name).toBe('validation_error')
    expect(message).toContain('emails[1].to')
    expect(message).not.toContain('not-an-address')
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key'])
  })

  it.each([
    ['an object instead of an array', EMAIL],
    ['an empty array', []],
    ['101 emails', Array.from({ length: 101 }, () => EMAIL)],
  ])('refuses %s', async (_, body) => {
    mockRpc({ authenticate_key: () => KEY_OK })
    const response = await post(body)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ name: 'validation_error' })
  })

  it('answers SQL’s refusal for the whole batch, naming the email refused', async () => {
    mockRpc({
      authenticate_key: () => KEY_OK,
      enqueue_batch: () => ({ ok: false, code: 'domain_not_verified', index: 3 }),
    })
    const response = await post([EMAIL])
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.name).toBe('domain_not_verified')
    expect(body.message).toMatch(/^emails\[3\]: /)
    expect(JSON.stringify(info.mock.calls)).not.toContain('ada@example.com')
  })

  it('refuses the whole batch for the first email the content check refuses, by its place', async () => {
    const calls = mockRpc({ authenticate_key: () => KEY_OK })
    const response = await post([EMAIL, { ...EMAIL, text: 'Pay at https://tinyurl.com/x' }])
    expect(response.status).toBe(422)
    expect((await response.json()).message).toMatch(/^emails\[1\]: .*shortener/)
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key'])
  })

  it('answers a refusal of the batch itself without an index', async () => {
    mockRpc({
      authenticate_key: () => KEY_OK,
      enqueue_batch: () => ({ ok: false, code: 'idempotency_conflict' }),
    })
    const response = await post([EMAIL], { 'idempotency-key': 'k' })
    expect(response.status).toBe(409)
    expect((await response.json()).message).not.toContain('emails[')
  })

  it('refuses a bad key, a bad Idempotency-Key, or a body that is not JSON', async () => {
    mockRpc({ authenticate_key: () => ({ ok: false, code: 'unauthorized' }) })
    expect((await post([EMAIL])).status).toBe(401)
    mockRpc({ authenticate_key: () => KEY_OK })
    expect((await post([EMAIL], { 'idempotency-key': 'has space' })).status).toBe(422)
    expect((await post('[{')).status).toBe(422)
  })

  it('takes no GET: the API’s own 405, with x-request-id', async () => {
    const { GET } = await import('@/app/api/v1/emails/batch/route')
    const response = await GET(new Request('http://localhost:3001/api/v1/emails/batch'))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(await response.json()).toMatchObject({ name: 'not_found' })
  })
})
