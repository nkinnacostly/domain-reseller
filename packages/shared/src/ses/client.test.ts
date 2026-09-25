import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifySesError,
  createSesClient,
  mailbox,
  type SesSettings,
  sesErrorType,
  sesSendUrl,
  sesTags,
} from './client'
import type { Fetch, FetchInit } from './platform'

const EMAIL = {
  to: 'ada@gmail.com',
  subject: 'Your password was changed',
  html: '<p>Hi Ada</p>',
  text: 'Hi Ada',
  tags: ['security', 'password_changed'],
}

type Answer = { status: number; body?: unknown; errorType?: string }

function fakeFetch(answer: Answer | Error) {
  const calls: { url: string; init: FetchInit }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    if (answer instanceof Error) throw answer
    return {
      status: answer.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'x-amzn-errortype' ? (answer.errorType ?? null) : null,
      },
      text: async () =>
        typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? null),
    }
  }
  return { fetch, calls }
}

const settings = (fetch: Fetch, over: Partial<SesSettings> = {}): SesSettings => ({
  region: 'eu-west-2',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  configurationSet: 'mydomainshub',
  from: { name: 'MyDomainsHub', email: 'no-reply@notify.mydomainshub.com' },
  replyTo: { name: 'MyDomainsHub', email: 'hello@mydomainshub.com' },
  fetch,
  now: () => new Date('2026-09-25T08:00:00Z'),
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('SES SendEmail', () => {
  it('posts a signed v2 SendEmail from the no-reply address, replies to the inbox, both bodies, tagged', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: { MessageId: '0102abc-000000' } })
    const ses = createSesClient(settings(fetch))

    expect(await ses.send(EMAIL)).toEqual({ ok: true, messageId: '0102abc-000000' })
    const [call] = calls
    expect(call?.url).toBe('https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails')
    expect(call?.init.method).toBe('POST')
    expect(JSON.parse(call?.init.body ?? '')).toEqual({
      FromEmailAddress: 'MyDomainsHub <no-reply@notify.mydomainshub.com>',
      Destination: { ToAddresses: ['ada@gmail.com'] },
      ReplyToAddresses: ['MyDomainsHub <hello@mydomainshub.com>'],
      Content: {
        Simple: {
          Subject: { Data: 'Your password was changed', Charset: 'UTF-8' },
          Body: {
            Html: { Data: '<p>Hi Ada</p>', Charset: 'UTF-8' },
            Text: { Data: 'Hi Ada', Charset: 'UTF-8' },
          },
        },
      },
      ConfigurationSetName: 'mydomainshub',
      EmailTags: [
        { Name: 'category', Value: 'security' },
        { Name: 'kind', Value: 'password_changed' },
      ],
    })
    const headers = call?.init.headers ?? {}
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-amz-date']).toBe('20260925T080000Z')
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260925\/eu-west-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    expect(JSON.stringify(call?.init)).not.toContain('wJalrXUtnFEMI')
  })

  it('leaves tags out when there are none, and copes with an answer without an id', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: 'not json' })
    expect(await createSesClient(settings(fetch)).send({ ...EMAIL, tags: [] })).toEqual({
      ok: true,
      messageId: null,
    })
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).not.toHaveProperty('EmailTags')
  })

  it('treats a rejected message as final, never quoting SES’s text (it names the address)', async () => {
    const { fetch } = fakeFetch({
      status: 400,
      errorType: 'MessageRejected:http://internal.amazon.com/coral/com.amazonaws.sesv2/',
      body: { message: 'Email address is not verified: ada@gmail.com' },
    })
    const outcome = await createSesClient(settings(fetch)).send(EMAIL)
    expect(outcome).toEqual({
      ok: false,
      permanent: true,
      status: 400,
      code: 'MessageRejected',
      error: 'HTTP 400 MessageRejected',
      attention: null,
    })
    expect(JSON.stringify(outcome)).not.toContain('ada@gmail.com')
  })

  it('treats a bad request about the message as final, read from the body when no header', async () => {
    const { fetch } = fakeFetch({
      status: 400,
      body: { __type: 'com.amazonaws.sesv2#BadRequestException', message: 'Illegal address' },
    })
    expect(await createSesClient(settings(fetch)).send(EMAIL)).toMatchObject({
      ok: false,
      permanent: true,
      code: 'BadRequestException',
    })
  })

  it.each([
    [429, 'TooManyRequestsException', null],
    [400, 'LimitExceededException', null],
    [503, null, null],
    [500, 'InternalFailure', null],
    [400, 'SendingPausedException', 'sending_paused'],
    [400, 'AccountSuspendedException', 'account_suspended'],
    [400, 'MailFromDomainNotVerifiedException', 'configuration'],
    [404, 'NotFoundException', 'configuration'],
    [403, 'SignatureDoesNotMatch', 'credentials'],
    [403, null, 'credentials'],
    [400, 'SomethingNewException', null],
  ])('tries again after HTTP %s %s (attention: %s)', async (status, errorType, attention) => {
    const { fetch } = fakeFetch({ status, ...(errorType ? { errorType } : {}), body: {} })
    expect(await createSesClient(settings(fetch)).send(EMAIL)).toMatchObject({
      ok: false,
      permanent: false,
      status,
      attention,
    })
  })

  it('may send again after no answer — a duplicate beats a lost notice', async () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    const silent = createSesClient(settings(fakeFetch(timeout).fetch))
    expect(await silent.send(EMAIL)).toEqual({
      ok: false,
      permanent: false,
      status: null,
      code: null,
      error: 'no answer from SES',
      attention: null,
    })
    const unreachable = createSesClient(settings(fakeFetch(new TypeError('fetch failed')).fetch))
    expect(await unreachable.send(EMAIL)).toMatchObject({
      permanent: false,
      error: 'could not reach SES',
    })
  })

  it('uses the platform fetch when none is given, with a timeout', async () => {
    const seen: { url: string; init: FetchInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: FetchInit) => {
      seen.push({ url, init })
      return { status: 200, headers: { get: () => null }, text: async () => '{"MessageId":"m-1"}' }
    })
    const { fetch: _fetch, now: _now, ...rest } = settings(fakeFetch({ status: 200 }).fetch)
    expect(await createSesClient(rest).send(EMAIL)).toEqual({ ok: true, messageId: 'm-1' })
    expect(seen[0]?.url).toBe(sesSendUrl('eu-west-2'))
    expect(seen[0]?.init.signal).toBeDefined()
  })

  it('refuses settings that would send elsewhere or cannot sign', () => {
    const { fetch } = fakeFetch({ status: 200 })
    expect(() => createSesClient(settings(fetch, { region: 'evil.com/x' }))).toThrow(
      'not an AWS region',
    )
    expect(() => createSesClient(settings(fetch, { configurationSet: 'bad name' }))).toThrow(
      'configuration set',
    )
    expect(() => createSesClient(settings(fetch, { secretAccessKey: '' }))).toThrow(
      'credentials are missing',
    )
  })
})

describe('SES helpers', () => {
  it('keeps tag values to the characters SES allows, and drops empty ones', () => {
    expect(sesTags(['auth', 'magic link!', '…', 'x'.repeat(300)])).toEqual([
      { Name: 'category', Value: 'auth' },
      { Name: 'kind', Value: 'magic_link_' },
      { Name: 'tag4', Value: 'x'.repeat(256) },
    ])
    expect(sesTags()).toEqual([])
  })

  it('quotes a display name only when it needs it', () => {
    expect(mailbox({ name: 'MyDomainsHub', email: 'a@b.com' })).toBe('MyDomainsHub <a@b.com>')
    expect(mailbox({ name: 'Ops, "Team"', email: 'a@b.com' })).toBe('"Ops, \\"Team\\"" <a@b.com>')
  })

  it('reads SES’s error type from the header or the body, and nothing else', () => {
    expect(sesErrorType('MessageRejected:http://internal.amazon.com/', null)).toBe(
      'MessageRejected',
    )
    expect(sesErrorType(null, { code: 'TooManyRequestsException' })).toBe(
      'TooManyRequestsException',
    )
    expect(sesErrorType(null, { message: 'x' })).toBeNull()
    expect(sesErrorType('not a <type>', null)).toBeNull()
    expect(sesErrorType(null, null)).toBeNull()
  })

  it('classifies: only a refused message is final', () => {
    expect(classifySesError(400, 'MessageRejected')).toEqual({ permanent: true, attention: null })
    expect(classifySesError(400, null)).toEqual({ permanent: false, attention: null })
    expect(classifySesError(401, null)).toEqual({ permanent: false, attention: 'credentials' })
  })
})
