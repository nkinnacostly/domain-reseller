import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '@/lib/env'
import { server } from '../../../../tests/mocks/server'
import { BREVO_SEND_URL, sendEmail } from '../brevo'

const settings = env as { BREVO_API_KEY?: string }
let before: string | undefined
beforeEach(() => {
  before = settings.BREVO_API_KEY
  settings.BREVO_API_KEY = 'test-brevo-key'
})
afterEach(() => {
  settings.BREVO_API_KEY = before
})

const EMAIL = {
  to: 'ada@example.com',
  subject: 'Reset your password',
  html: '<p>Hi</p>',
  text: 'Hi',
  tags: ['auth', 'recovery'],
}

describe('sendEmail (L1)', () => {
  it('sends from the no-reply address with replies to the support inbox', async () => {
    let sent: { headers: Headers; body: unknown } | undefined
    server.use(
      http.post(BREVO_SEND_URL, async ({ request }) => {
        sent = { headers: request.headers, body: await request.json() }
        return HttpResponse.json({ messageId: '<abc@brevo>' }, { status: 201 })
      }),
    )
    expect(await sendEmail(EMAIL)).toEqual({ ok: true, messageId: '<abc@brevo>' })
    expect(sent?.headers.get('api-key')).toBe('test-brevo-key')
    expect(sent?.body).toEqual({
      sender: { name: 'MyDomainsHub', email: 'no-reply@notify.mydomainshub.com' },
      replyTo: { name: 'MyDomainsHub', email: 'hello@mydomainshub.com' },
      to: [{ email: 'ada@example.com' }],
      subject: 'Reset your password',
      htmlContent: '<p>Hi</p>',
      textContent: 'Hi',
      tags: ['auth', 'recovery'],
    })
  })

  it('leaves tags out when there are none, and copes with an answer without an id', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post(BREVO_SEND_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return new HttpResponse('not json', { status: 201 })
      }),
    )
    expect(await sendEmail({ ...EMAIL, tags: [] })).toEqual({ ok: true, messageId: null })
    expect(body).not.toHaveProperty('tags')
  })

  it('reports a refusal with its status', async () => {
    server.use(http.post(BREVO_SEND_URL, () => HttpResponse.json({}, { status: 400 })))
    expect(await sendEmail(EMAIL)).toEqual({ ok: false, status: 400 })
  })

  it('reports an unreachable Brevo as a temporary failure', async () => {
    server.use(http.post(BREVO_SEND_URL, () => HttpResponse.error()))
    expect(await sendEmail(EMAIL)).toEqual({ ok: false, status: 503 })
  })

  it('sends nothing without an API key', async () => {
    settings.BREVO_API_KEY = undefined
    expect(await sendEmail(EMAIL)).toEqual({ ok: false, status: 500 })
  })
})
