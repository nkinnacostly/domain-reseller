import { newWebhookSecret, webhookHeaders } from '@dr/shared/webhooks'
import { http } from 'msw'
import { Resend } from 'resend'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as cancelEmail } from '@/app/api/v1/emails/[id]/cancel/route'
import { GET as getEmail, PATCH as updateEmail } from '@/app/api/v1/emails/[id]/route'
import { POST as sendBatch } from '@/app/api/v1/emails/batch/route'
import { GET as listEmails, POST as sendEmail } from '@/app/api/v1/emails/route'
import { EXAMPLE_WEBHOOK_BODY } from '@/features/api/docs/webhooks'
import { noSuchPath } from '@/features/api/lib/handler'
import { server } from '../../../../tests/mocks/server'
import { mockRpc } from '../../../../tests/mocks/supabase'

/**
 * Resend's official Node SDK, unchanged, pointed at this API: the
 * "Switching from Resend" guide (/docs/resend) promises only what this file
 * proves (N9b, MAIL-SPEC §1: a claim of compatibility with another SDK needs
 * a test that runs that SDK against our API). The SDK's own requests reach
 * our own route handlers — MSW only stands where the network is — and the
 * database answers as its functions do. The SDK is pinned in package.json;
 * a new version is a new run of this file.
 *
 * Proven: emails.send (every field the SDK maps, Idempotency-Key, Buffer and
 * inline attachments), batch.send, emails.get, emails.update,
 * emails.cancel, its error shape, RESEND_BASE_URL alone, and
 * webhooks.verify on our signature.
 */

const BASE = 'https://mail.test/api/v1'
const KEY = `mdh_live_${'R3s3ndK3'.repeat(5)}`
const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const KEY_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const IDS = ['6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d', '7a2e4b63-3b1f-4a1c-8e66-1d2f3a4b5c6e']
const [ID = ''] = IDS

const FULL = { ok: true, keyId: KEY_ID, accountId: ACCOUNT, permission: 'full', domainId: null }

const ROW = {
  id: ID,
  from: 'Acme <receipts@acme.example>',
  to: ['ada@example.com'],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: 'Your receipt',
  tags: [],
  status: 'delivered',
  status_reason: null,
  created_at: '2026-10-08T09:30:00+00:00',
  scheduled_at: '2026-10-08T09:30:00+00:00',
  sent_at: '2026-10-08T09:30:02+00:00',
  delivered_at: '2026-10-08T09:30:04+00:00',
  bounced_at: null,
  complained_at: null,
  failed_at: null,
  canceled_at: null,
  last_event: 'delivery',
  last_event_at: '2026-10-08T09:30:04+00:00',
}

/** The SDK's fetch, answered by this app's route handlers. */
function serveTheApi() {
  const params = (id: string) => ({ params: Promise.resolve({ id }) })
  server.use(
    http.all(`${BASE}/*`, ({ request }) => {
      const path = new URL(request.url).pathname.replace('/api/v1', '')
      const id = /^\/emails\/([^/]+)/.exec(path)?.[1] ?? ''
      const shape =
        path === '/emails/batch' ? path : path.replace(/^\/emails\/[^/]+/, '/emails/:id')
      const route = `${request.method} ${shape}`
      if (route === 'POST /emails') return sendEmail(request)
      if (route === 'GET /emails') return listEmails(request)
      if (route === 'POST /emails/batch') return sendBatch(request)
      if (route === 'GET /emails/:id') return getEmail(request, params(id))
      if (route === 'PATCH /emails/:id') return updateEmail(request, params(id))
      if (route === 'POST /emails/:id/cancel') return cancelEmail(request, params(id))
      return noSuchPath()
    }),
  )
}

const resend = () => new Resend(KEY, { baseUrl: BASE })

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  serveTheApi()
  // The SDK prints every error answer outside production; the tests read them instead.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Resend’s SDK, sending', () => {
  it('emails.send: every field it maps arrives as ours, with the Idempotency-Key', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      enqueue_email: () => ({ ok: true, id: ID, status: 'queued', replayed: false }),
    })
    const answer = await resend().emails.send(
      {
        from: 'Acme <receipts@acme.example>',
        to: 'ada@example.com',
        cc: ['bola@example.com'],
        bcc: 'audit@acme.example',
        replyTo: 'help@acme.example',
        subject: 'Your receipt',
        html: '<p>Thanks!</p>',
        text: 'Thanks!',
        headers: { 'X-Entity-Ref-ID': 'order-1042' },
        tags: [{ name: 'order', value: '1042' }],
        scheduledAt: '2026-10-08T10:00:00+01:00',
      },
      { idempotencyKey: 'order-1042-receipt' },
    )

    expect(answer.error).toBeNull()
    expect(answer.data).toEqual({ id: ID })
    expect(answer.headers?.['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls.map((call) => call.fn)).toEqual(['authenticate_key', 'enqueue_email'])
    expect(calls[1]?.body).toMatchObject({
      p_account_id: ACCOUNT,
      p_email: {
        from: 'Acme <receipts@acme.example>',
        to: ['ada@example.com'],
        cc: ['bola@example.com'],
        bcc: ['audit@acme.example'],
        reply_to: ['help@acme.example'],
        subject: 'Your receipt',
        tags: [{ name: 'order', value: '1042' }],
        scheduled_at: '2026-10-08T09:00:00.000Z',
      },
      p_payload: {
        html: '<p>Thanks!</p>',
        text: 'Thanks!',
        headers: { 'X-Entity-Ref-ID': 'order-1042' },
        attachments: [],
      },
      p_idempotency_key: 'order-1042-receipt',
    })
  })

  it('emails.send: a Buffer as content, and an inline image by contentId', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      enqueue_email: () => ({ ok: true, id: ID, status: 'queued', replayed: false }),
    })
    const pdf = Buffer.from('%PDF-1.4\n')
    const answer = await resend().emails.send({
      from: 'receipts@acme.example',
      to: ['ada@example.com'],
      subject: 'Your receipt',
      html: '<img src="cid:logo" alt="Acme">',
      attachments: [
        { filename: 'receipt.pdf', content: pdf },
        { filename: 'logo.png', content: 'iVBORw0KGgo=', contentId: 'logo' },
      ],
    })

    expect(answer.error).toBeNull()
    expect(calls[1]?.body).toMatchObject({
      p_payload: {
        attachments: [
          {
            filename: 'receipt.pdf',
            content: pdf.toString('base64'),
            content_type: 'application/octet-stream',
          },
          {
            filename: 'logo.png',
            content: 'iVBORw0KGgo=',
            content_type: 'image/png',
            content_id: 'logo',
          },
        ],
      },
    })
  })

  it('batch.send: strict, as the SDK asks by default; { data: [{ id }] } back', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      enqueue_batch: () => ({ ok: true, ids: IDS, replayed: false }),
    })
    const email = {
      from: 'receipts@acme.example',
      to: 'ada@example.com',
      subject: 'Your receipt',
      text: 'Thanks!',
    }
    const answer = await resend().batch.send([email, { ...email, replyTo: ['help@acme.example'] }])

    expect(answer.error).toBeNull()
    expect(answer.data).toEqual({ data: [{ id: IDS[0] }, { id: IDS[1] }] })
    const sent = calls[1]?.body as { p_emails: { email: { reply_to: string[] } }[] }
    expect(sent.p_emails.map(({ email: e }) => e.reply_to)).toEqual([[], ['help@acme.example']])

    // permissive (some queued, some not) is not what this API does: refused whole.
    const permissive = await resend().batch.send([email], { batchValidation: 'permissive' })
    expect(permissive.data).toBeNull()
    expect(permissive.error).toMatchObject({ name: 'validation_error', statusCode: 422 })
  })
})

describe('Resend’s SDK, after sending', () => {
  it('emails.get reads the email back as object: "email"', async () => {
    mockRpc({ authenticate_key: () => FULL, get_email: () => ROW })
    const answer = await resend().emails.get(ID)
    expect(answer.error).toBeNull()
    expect(answer.data).toMatchObject({
      object: 'email',
      id: ID,
      to: ['ada@example.com'],
      subject: 'Your receipt',
      last_event: 'delivery',
    })
  })

  it('emails.list pages by limit; after and before are refused, pointing to cursor', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      list_emails: () => ({ ok: true, data: [ROW], hasMore: false, next: null }),
    })
    const page = await resend().emails.list({ limit: 1 })
    expect(page.error).toBeNull()
    expect(page.data).toMatchObject({ object: 'list', has_more: false, data: [{ id: ID }] })
    expect(calls[1]?.body).toMatchObject({ p_limit: 1 })

    const after = await resend().emails.list({ after: ID })
    expect(after.error).toMatchObject({
      name: 'validation_error',
      message: expect.stringContaining('next_cursor'),
      statusCode: 422,
    })
  })

  it('emails.update moves a scheduled email; emails.cancel cancels it', async () => {
    const calls = mockRpc({
      authenticate_key: () => FULL,
      reschedule_email: () => ({
        ok: true,
        id: ID,
        status: 'queued',
        scheduledAt: '2026-10-08T12:00:00.000000Z',
      }),
      cancel_email: () => ({
        ok: true,
        id: ID,
        status: 'canceled',
        scheduledAt: '2026-10-08T12:00:00.000000Z',
      }),
    })
    const moved = await resend().emails.update({ id: ID, scheduledAt: '2026-10-08T12:00:00Z' })
    expect(moved.error).toBeNull()
    expect(moved.data).toMatchObject({ object: 'email', id: ID })
    expect(calls[1]?.body).toMatchObject({ p_scheduled_at: '2026-10-08T12:00:00.000Z' })

    const canceled = await resend().emails.cancel(ID)
    expect(canceled.error).toBeNull()
    expect(canceled.data).toMatchObject({ object: 'email', id: ID, status: 'canceled' })
  })
})

describe('Resend’s SDK, refused', () => {
  it('reads our errors as its own: { name, message, statusCode }, data null', async () => {
    mockRpc({
      authenticate_key: () => FULL,
      enqueue_email: () => ({ ok: false, code: 'domain_not_verified' }),
    })
    const answer = await resend().emails.send({
      from: 'hello@not-verified.example',
      to: 'ada@example.com',
      subject: 'Hi',
      text: 'Hi',
    })
    expect(answer.data).toBeNull()
    expect(answer.error).toEqual({
      name: 'domain_not_verified',
      message: expect.stringContaining('not verified'),
      statusCode: 403,
    })
    expect(consoleError).toHaveBeenCalled()
  })

  it('a wrong key is 401; a field we do not take says what to send instead', async () => {
    mockRpc({ authenticate_key: () => ({ ok: false, code: 'unauthorized' }) })
    const wrongKey = await new Resend('re_123', { baseUrl: BASE }).emails.send({
      from: 'receipts@acme.example',
      to: 'ada@example.com',
      subject: 'Hi',
      text: 'Hi',
    })
    expect(wrongKey.error).toMatchObject({ name: 'unauthorized', statusCode: 401 })

    mockRpc({ authenticate_key: () => FULL })
    const template = await resend().emails.send({
      from: 'receipts@acme.example',
      to: 'ada@example.com',
      template: { id: 'order-confirmation' },
    })
    expect(template.error).toMatchObject({
      name: 'validation_error',
      message: expect.stringContaining('stored templates are not supported'),
      statusCode: 422,
    })
  })

  it('what this API does not have — contacts, say — is a JSON 404 the SDK reports', async () => {
    const answer = await resend().contacts.list()
    expect(answer.data).toBeNull()
    expect(answer.error).toMatchObject({ name: 'not_found', statusCode: 404 })
  })
})

describe('Resend’s SDK, configured as the guide says', () => {
  it('RESEND_BASE_URL alone points it here, with no code change', async () => {
    vi.stubEnv('RESEND_BASE_URL', BASE)
    mockRpc({
      authenticate_key: () => FULL,
      enqueue_email: () => ({ ok: true, id: ID, status: 'queued', replayed: false }),
    })
    const answer = await new Resend(KEY).emails.send({
      from: 'receipts@acme.example',
      to: 'ada@example.com',
      subject: 'Hi',
      text: 'Hi',
    })
    expect(answer).toMatchObject({ data: { id: ID }, error: null })
  })

  it('webhooks.verify accepts our signature (Standard Webhooks, whsec_ secrets)', async () => {
    const secret = newWebhookSecret()
    const headers = await webhookHeaders(secret, 'msg_2nQ8Zz', EXAMPLE_WEBHOOK_BODY)
    const event = resend().webhooks.verify({
      payload: EXAMPLE_WEBHOOK_BODY,
      headers: {
        id: headers['webhook-id'],
        timestamp: headers['webhook-timestamp'],
        signature: headers['webhook-signature'],
      },
      webhookSecret: secret,
    })
    expect(event).toMatchObject({ type: 'email.delivered', data: { email_id: expect.any(String) } })
    expect(() =>
      resend().webhooks.verify({
        payload: EXAMPLE_WEBHOOK_BODY.replace('delivered', 'bounced'),
        headers: {
          id: headers['webhook-id'],
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
        },
        webhookSecret: secret,
      }),
    ).toThrow()
  })
})
