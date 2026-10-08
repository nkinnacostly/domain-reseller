import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendEmail } from '@/lib/email/send'
import { env } from '@/lib/env'
import { withinLimit } from '@/lib/rate-limit'

vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: vi.fn(async (scope: string) => `${scope}:test`),
  withinLimit: vi.fn(async () => true),
}))
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }))

const { POST } = await import('@/app/api/auth/send-email/route')

const RAW = Buffer.from('route-test-secret-thirty-two-byte').toString('base64')
const SECRET = `v1,whsec_${RAW}`
const settings = env as { SEND_EMAIL_HOOK_SECRET?: string }
let before: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  before = settings.SEND_EMAIL_HOOK_SECRET
  settings.SEND_EMAIL_HOOK_SECRET = SECRET
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, messageId: 'm1' })
})
afterEach(() => {
  settings.SEND_EMAIL_HOOK_SECRET = before
})

const PAYLOAD = {
  user: { email: 'ada@example.com' },
  email_data: { email_action_type: 'recovery', token_hash: 'hash-1', token: '123456' },
}

function request(body: string, signed = true) {
  const id = 'msg_1'
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = `v1,${createHmac('sha256', Buffer.from(RAW, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`
  return new NextRequest('https://www.mydomainshub.com/api/auth/send-email', {
    method: 'POST',
    body,
    headers: signed
      ? { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature }
      : {},
  })
}

describe('POST /api/auth/send-email (L1)', () => {
  it('sends the email Supabase asks for and answers 200', async () => {
    const response = await POST(request(JSON.stringify(PAYLOAD)))
    expect(response.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ada@example.com', subject: 'Reset your password' }),
    )
  })

  it('sends a Mail page’s email worded as Mail’s, linking to Mail (MAIL-SPEC M5)', async () => {
    const body = JSON.stringify({
      ...PAYLOAD,
      email_data: { ...PAYLOAD.email_data, redirect_to: 'https://emails.mydomainshub.com/x' },
    })
    const response = await POST(request(body))
    expect(response.status).toBe(200)
    const email = vi.mocked(sendEmail).mock.calls[0]?.[0]
    expect(email?.text.startsWith('MyDomainsHub Mail\n')).toBe(true)
    expect(email?.html).toContain('href="https://emails.mydomainshub.com/auth/confirm?')
  })

  it('refuses a request Supabase did not sign, and sends nothing', async () => {
    const response = await POST(request(JSON.stringify(PAYLOAD), false))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { http_code: 401, message: 'Invalid signature' },
    })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('holds back a sixth email to one address within the hour (security audit)', async () => {
    vi.mocked(withinLimit).mockResolvedValueOnce(false)
    const response = await POST(request(JSON.stringify(PAYLOAD)))
    expect(response.status).toBe(429)
    expect(sendEmail).not.toHaveBeenCalled()
    // Keyed by a hash of the address, never the address itself.
    const [key] = vi.mocked(withinLimit).mock.calls.at(-1) ?? []
    expect(key).toMatch(/^auth_email:[0-9a-f]{32}$/)
  })

  it('says so when the email could not be sent, so Supabase shows an error', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ ok: false, status: 503 })
    const response = await POST(request(JSON.stringify(PAYLOAD)))
    expect(response.status).toBe(502)
  })

  it('answers 200 without sending for an action we do not use', async () => {
    const body = JSON.stringify({ ...PAYLOAD, email_data: { email_action_type: 'invite' } })
    const response = await POST(request(body))
    expect(response.status).toBe(200)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('refuses a signed body that is not a payload', async () => {
    expect((await POST(request('not json'))).status).toBe(400)
    expect((await POST(request(JSON.stringify({ user: {} })))).status).toBe(400)
  })

  it('refuses an oversized body before reading it as JSON', async () => {
    expect((await POST(request('x'.repeat(70 * 1024)))).status).toBe(413)
  })

  it('fails closed when the hook secret is not configured', async () => {
    settings.SEND_EMAIL_HOOK_SECRET = undefined
    expect((await POST(request(JSON.stringify(PAYLOAD)))).status).toBe(500)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
