import { describe, expect, it } from 'vitest'
import { fromBase64 } from './base64'
import { signRequest } from './sigv4'
import {
  classifyTenantSend,
  createTenantSender,
  type TenantEmail,
  tenantSendBody,
} from './tenant-send'
import { EXAMPLE_CREDENTIALS, recordingFetch } from './test-fetch'

const EMAIL: TenantEmail = {
  tenantName: 'mdm-0a1b2c3d4e',
  configurationSetName: 'mdm-0a1b2c3d4e',
  emailId: '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d',
  accountShortId: '0a1b2c3d4e',
  from: 'Acme <receipts@acme.example>',
  to: ['ada@example.com'],
  bcc: ['audit@example.com'],
  subject: 'Your receipt',
  html: '<p>Thanks!</p>',
  text: 'Thanks!',
  tags: [{ name: 'kind', value: 'receipt' }],
}

/** Raw MIME is ASCII by construction. */
const decode = (base64: string) => String.fromCharCode(...(fromBase64(base64) ?? []))

describe('Mail’s SendEmail names its tenant (MR1)', () => {
  it('posts the recorded v2 shape: tenant, configuration set, our tags, Bcc in Destination only', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { MessageId: '0102019a-msg' } })
    const sender = createTenantSender({ ...EXAMPLE_CREDENTIALS, fetch })

    expect(await sender.send(EMAIL)).toEqual({ ok: true, messageId: '0102019a-msg' })
    const [call] = calls
    expect(call?.url).toBe('https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails')
    expect(call?.init.method).toBe('POST')
    expect(JSON.parse(call?.init.body ?? '')).toEqual({
      FromEmailAddress: 'Acme <receipts@acme.example>',
      Destination: { ToAddresses: ['ada@example.com'], BccAddresses: ['audit@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'Your receipt', Charset: 'UTF-8' },
          Body: {
            Text: { Data: 'Thanks!', Charset: 'UTF-8' },
            Html: { Data: '<p>Thanks!</p>', Charset: 'UTF-8' },
          },
        },
      },
      ConfigurationSetName: 'mdm-0a1b2c3d4e',
      TenantName: 'mdm-0a1b2c3d4e',
      EmailTags: [
        { Name: 'mdm_email', Value: '6f1d3a52-2a0e-4f0b-9d55-0c1f2a3b4c5d' },
        { Name: 'mdm_account', Value: '0a1b2c3d4e' },
        { Name: 'kind', Value: 'receipt' },
      ],
    })
  })

  it('is signed with SigV4 for ses in eu-west-2, over exactly this body', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { MessageId: 'm' } })
    await createTenantSender({ ...EXAMPLE_CREDENTIALS, fetch }).send(EMAIL)
    const init = calls[0]?.init
    const again = await signRequest(
      {
        method: 'POST',
        url: 'https://email.eu-west-2.amazonaws.com/v2/email/outbound-emails',
        headers: { 'content-type': 'application/json' },
        body: init?.body ?? '',
      },
      EXAMPLE_CREDENTIALS,
      { region: 'eu-west-2', service: 'ses' },
      EXAMPLE_CREDENTIALS.now(),
    )
    expect(init?.headers['x-amz-date']).toBe('20261006T093000Z')
    expect(init?.headers.authorization).toBe(again.headers.authorization)
    expect(init?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261006\/eu-west-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    expect(JSON.stringify(init)).not.toContain('wJalrXUtnFEMI')
  })

  it.each([
    ['no tenant', { tenantName: '' }],
    ['no configuration set', { configurationSetName: '' }],
    ['the shop’s configuration set', { configurationSetName: 'mydomainshub' }],
    ['a tenant that is not Mail’s', { tenantName: 'someone-else' }],
  ])('refuses a send with %s, before anything is signed or sent', async (_, over) => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { MessageId: 'm' } })
    const outcome = await createTenantSender({ ...EXAMPLE_CREDENTIALS, fetch }).send({
      ...EMAIL,
      ...over,
    })
    expect(outcome).toMatchObject({ ok: false, kind: 'permanent', code: 'MissingTenant' })
    expect(calls).toHaveLength(0)
  })

  it('sends raw MIME when there are attachments or custom headers, and Bcc stays out of it', async () => {
    const body = tenantSendBody({
      ...EMAIL,
      cc: ['Bola <bola@example.com>'],
      replyTo: ['support@acme.example'],
      headers: { 'X-Entity-Ref-ID': 'order-1042' },
      attachments: [
        { filename: 'receipt.pdf', contentType: 'application/pdf', content: 'JVBERi0xLjQK' },
      ],
      date: new Date('2026-10-06T09:30:00Z'),
      boundary: () => 'b',
    })
    expect(body).toMatchObject({
      Destination: {
        ToAddresses: ['ada@example.com'],
        CcAddresses: ['Bola <bola@example.com>'],
        BccAddresses: ['audit@example.com'],
      },
      ReplyToAddresses: ['support@acme.example'],
      TenantName: 'mdm-0a1b2c3d4e',
      ConfigurationSetName: 'mdm-0a1b2c3d4e',
    })
    const raw = decode((body.Content as { Raw: { Data: string } }).Raw.Data)
    expect(raw).toContain('X-Entity-Ref-ID: order-1042\r\n')
    expect(raw).toContain('Content-Disposition: attachment; filename="receipt.pdf"')
    expect(raw).toContain('Cc: Bola <bola@example.com>\r\n')
    expect(raw).not.toContain('audit@example.com')
  })

  it('leaves out an empty body part and drops tags SES would refuse', () => {
    const body = tenantSendBody({ ...EMAIL, html: null, accountShortId: 'not ok!', tags: [] })
    expect(body.Content).toEqual({
      Simple: {
        Subject: { Data: 'Your receipt', Charset: 'UTF-8' },
        Body: { Text: { Data: 'Thanks!', Charset: 'UTF-8' } },
      },
    })
    expect(body.EmailTags).toEqual([{ Name: 'mdm_email', Value: EMAIL.emailId }])
    expect(tenantSendBody({ ...EMAIL, text: null, bcc: [] }).Destination).toEqual({
      ToAddresses: ['ada@example.com'],
    })
  })
})

describe('how a send ended (§4.4)', () => {
  it.each([
    [429, 'TooManyRequestsException', 'throttled'],
    [400, 'LimitExceededException', 'throttled'],
    [400, 'Throttling', 'throttled'],
    [400, 'MaxSendRateExceeded', 'throttled'],
    [400, 'MessageRejected', 'permanent'],
    [400, 'MailFromDomainNotVerifiedException', 'permanent'],
    [400, 'BadRequestException', 'permanent'],
    [400, 'SendingPausedException', 'retry'],
    [404, 'NotFoundException', 'retry'],
    [403, 'AccessDeniedException', 'retry'],
    [500, 'MessageRejected', 'retry'],
    [503, null, 'retry'],
    [null, null, 'retry'],
  ] as const)('HTTP %s %s is %s', (status, code, kind) => {
    expect(classifyTenantSend(status, code)).toBe(kind)
  })

  it('answers a throttle as throttled, never a failure', async () => {
    const { fetch } = recordingFetch({
      status: 429,
      errorType: 'TooManyRequestsException:http://x/',
    })
    expect(await createTenantSender({ ...EXAMPLE_CREDENTIALS, fetch }).send(EMAIL)).toEqual({
      ok: false,
      kind: 'throttled',
      status: 429,
      code: 'TooManyRequestsException',
      error: 'HTTP 429 TooManyRequestsException',
    })
  })

  it('treats no answer, or an answer without an id, as worth another try — never quoting SES’s text', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const silent = createTenantSender({
      ...EXAMPLE_CREDENTIALS,
      fetch: recordingFetch(timeout).fetch,
    })
    expect(await silent.send(EMAIL)).toMatchObject({
      ok: false,
      kind: 'retry',
      status: null,
      error: 'no answer from SES',
    })
    const odd = createTenantSender({
      ...EXAMPLE_CREDENTIALS,
      fetch: recordingFetch({ status: 200, body: {} }).fetch,
    })
    expect(await odd.send(EMAIL)).toMatchObject({ ok: false, kind: 'retry' })
    const rejected = createTenantSender({
      ...EXAMPLE_CREDENTIALS,
      fetch: recordingFetch({
        status: 400,
        errorType: 'MessageRejected',
        body: { message: 'Address ada@example.com' },
      }).fetch,
    })
    const outcome = await rejected.send(EMAIL)
    expect(outcome).toMatchObject({ ok: false, kind: 'permanent' })
    expect(JSON.stringify(outcome)).not.toContain('ada@example.com')
  })

  it('refuses settings it cannot sign with', () => {
    expect(() => createTenantSender({ ...EXAMPLE_CREDENTIALS, region: 'evil.com/x' })).toThrow(
      'region',
    )
    expect(() => createTenantSender({ ...EXAMPLE_CREDENTIALS, secretAccessKey: '' })).toThrow(
      'credentials',
    )
  })
})
