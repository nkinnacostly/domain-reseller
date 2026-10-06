import { hashApiKey } from '@dr/shared/mail'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/v1/emails/route'
import { logger } from '@/lib/logger'
import { mockRpc } from '../../../../tests/mocks/supabase'

/**
 * POST /api/v1/emails end to end inside the app: the route, the key door,
 * Zod, and the RPCs as PostgREST receives them (MSW at the network
 * boundary). SQL's own rules are proven by supabase/tests/mail_sending.sql;
 * here, that each SQL answer becomes the spec's answer (§6).
 */

const KEY = `mdh_live_${'A1b2C3d4'.repeat(5)}`
const PEPPER = 'test pepper, not a secret, 0123456789'
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const KEY_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const EMAIL_ID = '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d'

const EMAIL = {
  from: 'Acme <receipts@acme.example>',
  to: ['ada@example.com'],
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
}

const KEY_OK = {
  ok: true,
  keyId: KEY_ID,
  accountId: ACCOUNT,
  permission: 'sending',
  domainId: null,
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost:3001/api/v1/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

const queued = (over: Record<string, unknown> = {}) => ({
  ok: true,
  id: EMAIL_ID,
  status: 'queued',
  replayed: false,
  ...over,
})

let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  info = vi.spyOn(logger, 'info')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('POST /api/v1/emails — the happy path', () => {
  it('queues the email in schema mail and answers its id, with x-request-id', async () => {
    const calls = mockRpc({ authenticate_key: () => KEY_OK, enqueue_email: () => queued() })
    const response = await post(EMAIL)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: EMAIL_ID })
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.headers.get('cache-control')).toBe('no-store')

    expect(calls.map((call) => [call.fn, call.schema])).toEqual([
      ['authenticate_key', 'mail'],
      ['enqueue_email', 'mail'],
    ])
    // MR7: only the hash of the key reaches the database, never the key.
    expect(calls[0]?.body).toEqual({ p_key_hash: await hashApiKey(KEY, PEPPER) })
    expect(JSON.stringify(calls)).not.toContain(KEY)
    expect(calls[1]?.body).toEqual({
      p_account_id: ACCOUNT,
      p_api_key_id: KEY_ID,
      p_email: {
        from: 'Acme <receipts@acme.example>',
        to: ['ada@example.com'],
        cc: [],
        bcc: [],
        reply_to: [],
        subject: 'Your receipt',
        tags: [],
      },
      p_payload: { html: '<p>Thanks!</p>', text: null, headers: {}, attachments: [] },
    })
  })

  it('passes an Idempotency-Key with the request’s fingerprint, and answers a replay the same', async () => {
    const calls = mockRpc({
      authenticate_key: () => KEY_OK,
      enqueue_email: () => queued({ replayed: true }),
    })
    const response = await post(EMAIL, { 'idempotency-key': 'order-1042-receipt' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: EMAIL_ID })
    expect(calls[1]?.body).toMatchObject({
      p_idempotency_key: 'order-1042-receipt',
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('never logs an address, the subject, the body or the key (N13, MR4)', async () => {
    mockRpc({ authenticate_key: () => KEY_OK, enqueue_email: () => queued() })
    await post({ ...EMAIL, text: 'secret body' })
    const logged = JSON.stringify(info.mock.calls)
    expect(logged).toContain(EMAIL_ID)
    for (const secret of [
      'ada@example.com',
      'acme.example',
      'Your receipt',
      'Thanks',
      'secret body',
      KEY,
    ]) {
      expect(logged).not.toContain(secret)
    }
  })
})

describe('POST /api/v1/emails — the key door', () => {
  it.each([
    ['no Authorization header', {}],
    ['another scheme', { authorization: `Basic ${KEY}` }],
    ['something that is not a key', { authorization: 'Bearer sk_live_123' }],
  ])('refuses %s with 401, without asking the database', async (_, headers) => {
    const calls = mockRpc({})
    const response = await POST(
      new Request('http://localhost:3001/api/v1/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify(EMAIL),
      }),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ name: 'unauthorized' })
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(calls).toHaveLength(0)
  })

  it('refuses a revoked or unknown key as SQL says', async () => {
    mockRpc({ authenticate_key: () => ({ ok: false, code: 'unauthorized' }) })
    const response = await post(EMAIL)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      name: 'unauthorized',
      message: expect.stringContaining('missing, wrong or revoked'),
    })
  })

  it('answers 429 with retry-after when the key’s bucket is empty', async () => {
    const calls = mockRpc({
      authenticate_key: () => ({ ok: false, code: 'rate_limited', retryAfterMs: 1500 }),
    })
    const response = await post(EMAIL)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.json()).toMatchObject({ name: 'rate_limited' })
    expect(calls).toHaveLength(1)
  })
})

describe('POST /api/v1/emails — the content check (§7.6)', () => {
  it.each([
    ['a From that imitates a bank', { from: 'GTBank Alerts <alerts@acme.example>' }, 'imitates'],
    ['a link through a shortener', { html: '<a href="https://bit.ly/x">pay</a>' }, 'shortener'],
    [
      'a program attached',
      { attachments: [{ filename: 'invoice.apk', content: 'QQ==' }] },
      'program',
    ],
  ])('refuses %s with 422 before anything is queued or reserved', async (_, over, words) => {
    const calls = mockRpc({ authenticate_key: () => KEY_OK })
    const response = await post({ ...EMAIL, ...over })
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.name).toBe('validation_error')
    expect(body.message).toContain(words)
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key'])
    expect(JSON.stringify(info.mock.calls)).not.toContain('acme.example')
  })
})

describe('POST /api/v1/emails — validation', () => {
  it('refuses a bad Idempotency-Key before reading the body', async () => {
    const calls = mockRpc({ authenticate_key: () => KEY_OK })
    const response = await post(EMAIL, { 'idempotency-key': 'has spaces in it' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ name: 'validation_error' })
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key'])
  })

  it('refuses a body that is not JSON', async () => {
    mockRpc({ authenticate_key: () => KEY_OK })
    const response = await post('{"from":')
    expect(response.status).toBe(422)
    expect((await response.json()).message).toContain('JSON')
  })

  it('refuses a body over 4 MB with 413, by its declared length or its real one', async () => {
    mockRpc({ authenticate_key: () => KEY_OK })
    const declared = await post(EMAIL, { 'content-length': String(5 * 1024 * 1024) })
    expect(declared.status).toBe(413)
    const real = await post({ ...EMAIL, html: 'x'.repeat(4 * 1024 * 1024 + 1) })
    expect(real.status).toBe(413)
    expect(await real.json()).toMatchObject({ name: 'validation_error' })
  })

  it('names what is wrong by field, never quoting the value', async () => {
    const calls = mockRpc({ authenticate_key: () => KEY_OK })
    const response = await post({
      ...EMAIL,
      to: 'not-an-address',
      headers: { 'Return-Path': 'x@evil.example' },
    })
    expect(response.status).toBe(422)
    const { name, message } = await response.json()
    expect(name).toBe('validation_error')
    expect(message).toContain('to')
    expect(message).toContain('headers.Return-Path')
    expect(message).not.toContain('not-an-address')
    expect(message).not.toContain('evil.example')
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key'])
  })
})

describe('POST /api/v1/emails — what SQL refused', () => {
  it.each([
    [{ code: 'domain_not_verified' }, 403, 'domain_not_verified', null],
    [{ code: 'account_paused' }, 403, 'account_paused', null],
    [{ code: 'sandbox_recipient' }, 403, 'forbidden', null],
    [{ code: 'forbidden', reason: 'key_domain' }, 403, 'forbidden', null],
    [
      { code: 'quota_exceeded', scope: 'day', cap: 100, retryAfter: 3600 },
      429,
      'quota_exceeded',
      '3600',
    ],
    [{ code: 'budget_exceeded', retryAfter: 120 }, 429, 'quota_exceeded', '120'],
    [{ code: 'idempotency_conflict' }, 409, 'validation_error', null],
    [{ code: 'validation', field: 'recipients' }, 422, 'validation_error', null],
  ])('%j → %i %s', async (refusal, status, name, retryAfter) => {
    mockRpc({ authenticate_key: () => KEY_OK, enqueue_email: () => ({ ok: false, ...refusal }) })
    const response = await post(EMAIL)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ name })
    expect(response.headers.get('retry-after')).toBe(retryAfter)
  })

  it('says a budget refusal is our limit, not the plan’s', async () => {
    mockRpc({
      authenticate_key: () => KEY_OK,
      enqueue_email: () => ({ ok: false, code: 'budget_exceeded', retryAfter: 60 }),
    })
    expect((await (await post(EMAIL)).json()).message).toContain('our limit, not your plan’s')
  })
})

describe('POST /api/v1/emails — when something breaks', () => {
  it('answers internal_error when the database fails, and logs no personal data', async () => {
    const error = vi.spyOn(logger, 'error')
    mockRpc({
      authenticate_key: () => KEY_OK,
      enqueue_email: () => ({
        status: 500,
        body: { code: 'XX000', message: 'boom ada@example.com' },
      }),
    })
    const response = await post(EMAIL)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ name: 'internal_error' })
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).toContain('enqueue_email')
    expect(logged).not.toContain('ada@example.com')
  })

  it('answers internal_error for an answer shaped like nothing SQL says', async () => {
    mockRpc({ authenticate_key: () => ({ surprise: true }) })
    const response = await post(EMAIL)
    expect(response.status).toBe(500)
  })

  it('answers internal_error, never a guess, when the pepper is not set', async () => {
    vi.stubEnv('MAIL_API_KEY_PEPPER', '')
    vi.resetModules()
    const { POST: fresh } = await import('@/app/api/v1/emails/route')
    const calls = mockRpc({})
    const response = await fresh(
      new Request('http://localhost:3001/api/v1/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}` },
        body: JSON.stringify(EMAIL),
      }),
    )
    expect(response.status).toBe(500)
    expect(calls).toHaveLength(0)
  })
})
