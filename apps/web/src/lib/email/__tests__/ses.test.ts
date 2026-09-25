import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/lib/env'
import { server } from '../../../../tests/mocks/server'

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))

const { logger } = await import('@/lib/logger')
const { sendWithSes } = await import('../ses')

const SES_URL = 'https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails'
type Settings = {
  AWS_SES_REGION?: string
  AWS_SES_ACCESS_KEY_ID?: string
  AWS_SES_SECRET_ACCESS_KEY?: string
  AWS_SES_CONFIGURATION_SET?: string
}
const settings = env as Settings
/** AWS's documented example key pair — never a real one. */
const SES: Settings = {
  AWS_SES_REGION: 'eu-west-2',
  AWS_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SES_CONFIGURATION_SET: 'mydomainshub',
}
SES['AWS_SES_SECRET_ACCESS_KEY' as keyof Settings] = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
let before: Settings

beforeEach(() => {
  vi.clearAllMocks()
  before = { ...settings }
  Object.assign(settings, SES)
})
afterEach(() => {
  for (const key of Object.keys(SES) as (keyof Settings)[]) settings[key] = before[key]
})

const EMAIL = {
  to: 'ada@gmail.com',
  subject: 'Reset your password',
  html: '<p>Hi</p>',
  text: 'Hi',
  tags: ['auth', 'recovery'],
}

const logged = () =>
  JSON.stringify([
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
  ])

describe('sendWithSes (L1)', () => {
  it('sends from the no-reply address with replies to the support inbox, signed, in the configuration set', async () => {
    let sent: { headers: Headers; body: Record<string, unknown> } | undefined
    server.use(
      http.post(SES_URL, async ({ request }) => {
        sent = { headers: request.headers, body: (await request.json()) as Record<string, unknown> }
        return HttpResponse.json({ MessageId: '0102-abc-000000' })
      }),
    )
    expect(await sendWithSes(EMAIL)).toEqual({ ok: true, messageId: '0102-abc-000000' })
    expect(sent?.body).toMatchObject({
      FromEmailAddress: 'MyDomainsHub <no-reply@notify.mydomainshub.com>',
      ReplyToAddresses: ['MyDomainsHub <hello@mydomainshub.com>'],
      Destination: { ToAddresses: ['ada@gmail.com'] },
      ConfigurationSetName: 'mydomainshub',
      EmailTags: [
        { Name: 'category', Value: 'auth' },
        { Name: 'kind', Value: 'recovery' },
      ],
    })
    expect(sent?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-2\/ses\/aws4_request, /,
    )
    expect(logged()).not.toContain('ada@gmail.com')
  })

  it('reports a rejected message with its status, never SES’s text', async () => {
    server.use(
      http.post(SES_URL, () =>
        HttpResponse.json(
          { message: 'Email address is not verified: ada@gmail.com' },
          { status: 400, headers: { 'x-amzn-ErrorType': 'MessageRejected' } },
        ),
      ),
    )
    expect(await sendWithSes(EMAIL)).toEqual({ ok: false, status: 400 })
    expect(logger.error).toHaveBeenCalledWith(
      { status: 400, code: 'MessageRejected', tags: EMAIL.tags },
      'email refused by SES',
    )
    expect(logged()).not.toContain('ada@gmail.com')
  })

  it('says clearly when SES has paused sending', async () => {
    server.use(
      http.post(SES_URL, () =>
        HttpResponse.json(
          {},
          { status: 400, headers: { 'x-amzn-ErrorType': 'SendingPausedException' } },
        ),
      ),
    )
    expect(await sendWithSes(EMAIL)).toEqual({ ok: false, status: 400 })
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ attention: 'sending_paused' }),
      expect.stringContaining('paused sending'),
    )
  })

  it('reports an unreachable SES as a temporary failure', async () => {
    server.use(http.post(SES_URL, () => HttpResponse.error()))
    expect(await sendWithSes(EMAIL)).toEqual({ ok: false, status: 503 })
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'could not reach SES' }),
      'email send failed',
    )
  })

  it('sends nothing without its settings, and names what is missing — never a value', async () => {
    delete settings.AWS_SES_SECRET_ACCESS_KEY
    delete settings.AWS_SES_CONFIGURATION_SET
    expect(await sendWithSes({ ...EMAIL, tags: [] })).toEqual({ ok: false, status: 500 })
    expect(logger.error).toHaveBeenCalledWith(
      { missing: ['AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_CONFIGURATION_SET'] },
      'SES is not configured: email not sent',
    )
    expect(logged()).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })
})
