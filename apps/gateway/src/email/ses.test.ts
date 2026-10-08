import type { Fetch, FetchInit } from '@dr/shared/ses'
import { describe, expect, it, vi } from 'vitest'
import { createSesMailer } from './ses'

const MESSAGE = {
  to: 'ada@gmail.com',
  subject: 'Receipt for order ND-001040',
  html: '<p>hi</p>',
  text: 'hi',
  tags: ['transactional', 'order_receipt'],
}

type Answer = { status: number; body?: unknown; errorType?: string }

function answering(...answers: (Answer | Error)[]) {
  const calls: { url: string; init: FetchInit }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)] as Answer | Error
    if (answer instanceof Error) throw answer
    return {
      status: answer.status,
      headers: { get: (name) => (name === 'x-amzn-errortype' ? (answer.errorType ?? null) : null) },
      text: async () => JSON.stringify(answer.body ?? {}),
    }
  }
  return { fetch, calls }
}

const log = { error: vi.fn() }

const mailer = (fetch: Fetch) =>
  createSesMailer({
    region: 'eu-west-2',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    configurationSet: 'mydomainshub',
    log,
    fetch,
    now: () => new Date('2026-09-25T08:00:00Z'),
  })

describe('SES mailer (L1)', () => {
  it('sends as Brevo did — the no-reply subdomain, replies to the inbox — in the configuration set', async () => {
    const { fetch, calls } = answering({ status: 200, body: { MessageId: '0102-abc-000000' } })
    const ses = mailer(fetch)
    expect(ses.provider).toBe('ses')
    expect(ses.delivery).toBeUndefined()
    expect(await ses.send(MESSAGE)).toEqual({ ok: true, messageId: '0102-abc-000000' })

    const body = JSON.parse(calls[0]?.init.body ?? '{}')
    expect(calls[0]?.url).toBe('https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails')
    expect(body.FromEmailAddress).toBe('MyDomainsHub <no-reply@notify.mydomainshub.com>')
    expect(body.ReplyToAddresses).toEqual(['MyDomainsHub <hello@mydomainshub.com>'])
    expect(body.ConfigurationSetName).toBe('mydomainshub')
    expect(body.EmailTags).toEqual([
      { Name: 'category', Value: 'transactional' },
      { Name: 'kind', Value: 'order_receipt' },
    ])
  })

  it('sends a product’s notice under its name, from the same address', async () => {
    const { fetch, calls } = answering({ status: 200, body: { MessageId: '0102-abc-000001' } })
    await mailer(fetch).send({ ...MESSAGE, fromName: 'MyDomainsHub Mail' })
    const body = JSON.parse(calls[0]?.init.body ?? '{}')
    expect(body.FromEmailAddress).toBe('MyDomainsHub Mail <no-reply@notify.mydomainshub.com>')
    expect(body.ReplyToAddresses).toEqual(['MyDomainsHub <hello@mydomainshub.com>'])
  })

  it('fails a rejected message for good, without the address in the error', async () => {
    const { fetch } = answering({
      status: 400,
      errorType: 'MessageRejected',
      body: { message: 'Email address is not verified: ada@gmail.com' },
    })
    const outcome = await mailer(fetch).send(MESSAGE)
    expect(outcome).toEqual({ ok: false, permanent: true, error: 'HTTP 400 MessageRejected' })
    expect(JSON.stringify(outcome)).not.toContain('ada@gmail.com')
  })

  it('tries throttled and failed sends again', async () => {
    const { fetch } = answering(
      { status: 429, errorType: 'TooManyRequestsException' },
      { status: 503 },
    )
    const ses = mailer(fetch)
    expect(await ses.send(MESSAGE)).toEqual({
      ok: false,
      permanent: false,
      error: 'HTTP 429 TooManyRequestsException',
    })
    expect(await ses.send(MESSAGE)).toEqual({ ok: false, permanent: false, error: 'HTTP 503' })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('may send again after no answer — a duplicate beats a lost notice', async () => {
    const { fetch } = answering(new TypeError('fetch failed'))
    expect(await mailer(fetch).send(MESSAGE)).toEqual({
      ok: false,
      permanent: false,
      error: 'could not reach SES',
    })
  })

  it('says once, clearly, that SES has paused sending — and again after it recovers', async () => {
    log.error.mockClear()
    const { fetch } = answering(
      { status: 400, errorType: 'SendingPausedException' },
      { status: 400, errorType: 'SendingPausedException' },
      { status: 200, body: { MessageId: 'm' } },
      { status: 400, errorType: 'SendingPausedException' },
    )
    const ses = mailer(fetch)
    expect(await ses.send(MESSAGE)).toMatchObject({ ok: false, permanent: false })
    await ses.send(MESSAGE)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      { attention: 'sending_paused', code: 'SendingPausedException', status: 400 },
      expect.stringContaining('paused sending'),
    )
    await ses.send(MESSAGE)
    await ses.send(MESSAGE)
    expect(log.error).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('ada@gmail.com')
  })

  it('says so when the account is suspended', async () => {
    log.error.mockClear()
    const { fetch } = answering({ status: 400, errorType: 'AccountSuspendedException' })
    expect(await mailer(fetch).send(MESSAGE)).toMatchObject({ ok: false, permanent: false })
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ attention: 'account_suspended' }),
      expect.stringContaining('suspended'),
    )
  })
})
