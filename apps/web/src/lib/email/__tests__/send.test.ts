import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '@/lib/env'
import { server } from '../../../../tests/mocks/server'
import { emailProvider } from '../provider'
import { sendEmail } from '../send'

type Settings = Record<string, string | undefined>
const settings = env as unknown as Settings
const KEYS = [
  'EMAIL_PROVIDER',
  'BREVO_API_KEY',
  'AWS_SES_REGION',
  'AWS_SES_ACCESS_KEY_ID',
  'AWS_SES_SECRET_ACCESS_KEY',
  'AWS_SES_CONFIGURATION_SET',
]
let before: Settings

beforeEach(() => {
  before = Object.fromEntries(KEYS.map((key) => [key, settings[key]]))
  settings.BREVO_API_KEY = 'test-brevo-key'
  settings.AWS_SES_REGION = 'eu-west-2'
  settings.AWS_SES_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  settings[['AWS_SES', 'SECRET_ACCESS_KEY'].join('_')] = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  settings.AWS_SES_CONFIGURATION_SET = 'mydomainshub'
})
afterEach(() => {
  for (const key of KEYS) settings[key] = before[key]
})

const EMAIL = { to: 'ada@example.com', subject: 's', html: '<p>h</p>', text: 't' }

function watch() {
  const hits: string[] = []
  server.use(
    http.post('https://api.brevo.com/v3/smtp/email', () => {
      hits.push('brevo')
      return HttpResponse.json({ messageId: '<b@brevo>' }, { status: 201 })
    }),
    http.post('https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails', () => {
      hits.push('ses')
      return HttpResponse.json({ MessageId: 'ses-1' })
    }),
  )
  return hits
}

describe('choosing the email provider (L1)', () => {
  it('sends through Brevo when nothing is chosen', async () => {
    settings.EMAIL_PROVIDER = undefined
    const hits = watch()
    expect(emailProvider()).toBe('brevo')
    expect(await sendEmail(EMAIL)).toEqual({ ok: true, messageId: '<b@brevo>' })
    expect(hits).toEqual(['brevo'])
  })

  it('sends through SES once EMAIL_PROVIDER=ses, and never through Brevo', async () => {
    settings.EMAIL_PROVIDER = 'ses'
    const hits = watch()
    expect(emailProvider()).toBe('ses')
    expect(await sendEmail(EMAIL)).toEqual({ ok: true, messageId: 'ses-1' })
    expect(hits).toEqual(['ses'])
  })

  it('does not fall back to Brevo when SES is chosen but not configured', async () => {
    settings.EMAIL_PROVIDER = 'ses'
    settings.AWS_SES_REGION = undefined
    const hits = watch()
    expect(await sendEmail(EMAIL)).toEqual({ ok: false, status: 500 })
    expect(hits).toEqual([])
  })
})
