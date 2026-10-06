import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CertificateUnreachable,
  clearCertificateCache,
  confirmSubscription,
  fetchCertificate,
  isOnHost,
  snsHostFor,
  snsStringToSign,
  verifySnsMessage,
} from './sns'
import {
  AWS_SAMPLE_NOTIFICATION,
  AWS_SAMPLE_SIGNATURE_V1,
  AWS_SAMPLE_SIGNATURE_V2,
  FIXTURE_CERTIFICATE_PEM,
} from './test-fixtures'
import {
  type Fields,
  generateTestKeys,
  signSns,
  type TestKeys,
  testCertificate,
  toPem,
} from './test-signer'

/**
 * SNS signatures (the shop's L1, Mail's §4.2): a message is acted on only
 * when AWS signed it, for exactly our topic, with a certificate fetched from
 * the topic region's own SNS host. The same cases the shop's tests held when
 * the verifier lived in apps/web, plus AWS's documented sample signed by a
 * real X.509 certificate.
 */

const TOPIC = 'arn:aws:sns:eu-west-2:123456789012:mail-ses-events'
const HOST = 'sns.eu-west-2.amazonaws.com'
const CERT_URL = `https://${HOST}/SimpleNotificationService-0000test.pem`
const SUBSCRIBE_URL = `https://${HOST}/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=2336412f`

let keys: TestKeys
let pem: string
beforeAll(async () => {
  keys = await generateTestKeys()
  pem = toPem('CERTIFICATE', testCertificate(keys.spki))
})
beforeEach(() => clearCertificateCache())
afterEach(() => vi.unstubAllGlobals())

const served = (body: string = pem) => vi.fn(async (_url: string) => body)

const verify = (raw: unknown, fetch: (url: string) => Promise<string> = served()) =>
  verifySnsMessage(raw, { topicArn: TOPIC, fetchCertificate: fetch })

const EVENT = JSON.stringify({ eventType: 'Delivery', mail: { messageId: '0102-abc-000000' } })

const notification = (over: Fields = {}, version: '1' | '2' = '2') =>
  signSns(
    {
      Type: 'Notification',
      MessageId: 'b0a6a5c5-2f1e-5d1e-9c1e-0000000000aa',
      TopicArn: TOPIC,
      Message: EVENT,
      Timestamp: '2026-10-06T08:00:01.000Z',
      ...over,
    },
    keys,
    { version, certUrl: CERT_URL },
  )

const confirmation = (over: Fields = {}) =>
  signSns(
    {
      Type: 'SubscriptionConfirmation',
      MessageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b',
      Token: '2336412f',
      TopicArn: TOPIC,
      Message: `You have chosen to subscribe to the topic ${TOPIC}.`,
      SubscribeURL: SUBSCRIBE_URL,
      Timestamp: '2026-10-06T08:00:00.000Z',
      ...over,
    },
    keys,
    { certUrl: CERT_URL },
  )

describe('AWS’s documented sample, signed by a real certificate', () => {
  const sampleTopic = AWS_SAMPLE_NOTIFICATION.TopicArn
  const fetchCert = vi.fn(async () => FIXTURE_CERTIFICATE_PEM)

  it.each([
    ['1', AWS_SAMPLE_SIGNATURE_V1],
    ['2', AWS_SAMPLE_SIGNATURE_V2],
  ] as const)('verifies SignatureVersion %s', async (version, signature) => {
    const verdict = await verifySnsMessage(
      { ...AWS_SAMPLE_NOTIFICATION, SignatureVersion: version, Signature: signature },
      { topicArn: sampleTopic, fetchCertificate: fetchCert },
    )
    expect(verdict).toMatchObject({ ok: true, snsHost: 'sns.us-west-2.amazonaws.com' })
  })

  it('refuses the sample with its versions swapped', async () => {
    const verdict = await verifySnsMessage(
      { ...AWS_SAMPLE_NOTIFICATION, SignatureVersion: '2', Signature: AWS_SAMPLE_SIGNATURE_V1 },
      { topicArn: sampleTopic, fetchCertificate: fetchCert },
    )
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('SNS signatures', () => {
  it('accepts a notification signed with SignatureVersion 2 (SHA256withRSA)', async () => {
    const verdict = await verify(await notification())
    expect(verdict).toMatchObject({ ok: true, snsHost: HOST })
    expect(verdict.ok && verdict.message.Type).toBe('Notification')
  })

  it('accepts a notification signed with SignatureVersion 1 (SHA1withRSA)', async () => {
    expect(await verify(await notification({}, '1'))).toMatchObject({ ok: true })
  })

  it('accepts a bare public key as SNS’s certificate, as Node’s reader did', async () => {
    expect(
      await verify(await notification(), served(toPem('PUBLIC KEY', keys.spki))),
    ).toMatchObject({ ok: true })
  })

  it('signs the Subject when there is one, and only then', async () => {
    const signed = await notification({ Subject: 'Amazon SES Email Event' })
    expect(await verify(signed)).toMatchObject({ ok: true })
    expect(await verify({ ...signed, Subject: 'Something else' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
    const { Subject: _dropped, ...withoutSubject } = signed
    expect(await verify(withoutSubject)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('accepts a subscription confirmation over its own fields', async () => {
    expect(await verify(await confirmation())).toMatchObject({ ok: true })
    expect(await verify(await confirmation({ Type: 'UnsubscribeConfirmation' }))).toMatchObject({
      ok: true,
    })
  })

  it.each([
    ['Message', JSON.stringify({ eventType: 'Bounce' })],
    ['MessageId', 'another-id'],
    ['Timestamp', '2026-10-06T08:00:02.000Z'],
    ['Type', 'SubscriptionConfirmation'],
  ])('refuses a notification whose %s was changed after signing', async (field, value) => {
    const verdict = await verify({ ...(await notification()), [field]: value })
    expect(verdict.ok).toBe(false)
  })

  it('refuses a signature made with someone else’s key, or that is not base64', async () => {
    const other = await generateTestKeys()
    const forged = await signSns(
      { ...(await notification()), Signature: undefined, SignatureVersion: undefined },
      other,
    )
    expect(await verify(forged)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await verify({ ...(await notification()), Signature: 'not base64 at all!' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('refuses a message for another topic, even one validly signed', async () => {
    const other = 'arn:aws:sns:eu-west-2:123456789012:someone-else'
    expect(await verify(await notification({ TopicArn: other }))).toEqual({
      ok: false,
      reason: 'wrong_topic',
    })
    expect(
      await verifySnsMessage(await notification(), {
        topicArn: 'not an arn',
        fetchCertificate: served(),
      }),
    ).toEqual({ ok: false, reason: 'wrong_topic' })
  })

  it.each([
    ['plain http', `http://${HOST}/SimpleNotificationService-0000test.pem`],
    ['another host', 'https://attacker.example/SimpleNotificationService-0000test.pem'],
    ['a look-alike host', `https://${HOST}.attacker.example/cert.pem`],
    ['another region', 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem'],
    ['a port', `https://${HOST}:8443/SimpleNotificationService-x.pem`],
    ['credentials', `https://user:pass@${HOST}/SimpleNotificationService-x.pem`],
    ['not a .pem', `https://${HOST}/SimpleNotificationService-x.txt`],
    ['a query', `https://${HOST}/SimpleNotificationService-x.pem?x=1`],
    ['a fragment', `https://${HOST}/SimpleNotificationService-x.pem#x`],
    ['a nested path', `https://${HOST}/a/SimpleNotificationService-x.pem`],
    ['not a URL', 'nonsense'],
  ])('refuses a certificate URL with %s, before fetching anything', async (_label, url) => {
    const fetchCert = served()
    expect(await verify(await notification({ SigningCertURL: url }), fetchCert)).toEqual({
      ok: false,
      reason: 'bad_certificate_url',
    })
    expect(fetchCert).not.toHaveBeenCalled()
  })

  it.each([
    ['nothing', null],
    ['a string', 'hello'],
    ['an unknown type', { Type: 'Surprise' }],
    ['an unknown signature version', { SignatureVersion: '3' }],
    ['a missing field', { MessageId: undefined }],
    ['a subject that is not text', { Subject: 42 }],
  ])('refuses %s as malformed', async (_label, change) => {
    const raw =
      change === null || typeof change === 'string'
        ? change
        : { ...(await notification()), ...change }
    expect(await verify(raw)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses a confirmation without its token as malformed', async () => {
    expect(await verify({ ...(await confirmation()), Token: undefined })).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('fetches a certificate once, from SNS’s host, and keeps it', async () => {
    const fetchCert = served()
    await verify(await notification(), fetchCert)
    await verify(await notification({ MessageId: 'second' }), fetchCert)
    expect(fetchCert).toHaveBeenCalledTimes(1)
    expect(fetchCert).toHaveBeenCalledWith(CERT_URL)
  })

  it('keeps at most twenty certificates', async () => {
    const fetchCert = served()
    for (let i = 0; i < 21; i++) {
      await verify(
        await notification({
          SigningCertURL: `https://${HOST}/SimpleNotificationService-${i}.pem`,
        }),
        fetchCert,
      )
    }
    await verify(
      await notification({ SigningCertURL: `https://${HOST}/SimpleNotificationService-0.pem` }),
      fetchCert,
    )
    expect(fetchCert).toHaveBeenCalledTimes(22)
  })

  it('says when SNS’s certificate host could not be reached, so the message can come again', async () => {
    expect(
      await verify(await notification(), async () => {
        throw new CertificateUnreachable()
      }),
    ).toEqual({ ok: false, reason: 'certificate_unreachable' })
  })

  it('refuses when the host serves no certificate, or not an RSA one', async () => {
    expect(
      await verify(await notification(), async () => {
        throw new Error('certificate: HTTP 404')
      }),
    ).toEqual({ ok: false, reason: 'bad_certificate' })
    expect(await verify(await notification(), served('not a pem'))).toEqual({
      ok: false,
      reason: 'bad_certificate',
    })
    const subtle = (
      globalThis as unknown as {
        crypto: {
          subtle: {
            generateKey(a: unknown, e: boolean, u: string[]): Promise<{ publicKey: unknown }>
            exportKey(f: string, k: unknown): Promise<ArrayBuffer>
          }
        }
      }
    ).crypto.subtle
    const ec = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])
    const ecPem = toPem('PUBLIC KEY', new Uint8Array(await subtle.exportKey('spki', ec.publicKey)))
    expect(await verify(await notification(), served(ecPem))).toEqual({
      ok: false,
      reason: 'bad_certificate',
    })
  })

  it('builds the string to sign exactly as AWS documents it', () => {
    expect(
      snsStringToSign({
        Type: 'Notification',
        MessageId: 'm',
        TopicArn: 't',
        Message: 'hello',
        Timestamp: 'ts',
        SignatureVersion: '2',
        Signature: 's',
        SigningCertURL: 'u',
      }),
    ).toBe('Message\nhello\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n')
  })

  it('knows each region’s SNS host, and only for a real topic ARN', () => {
    expect(snsHostFor(TOPIC)).toBe(HOST)
    expect(snsHostFor('arn:aws:sns:eu-west-2:123:x')).toBeNull()
    expect(isOnHost(`https://${HOST}/?a=1`, HOST)).toBe(true)
    expect(isOnHost('not a url', HOST)).toBe(false)
  })
})

describe('the certificate fetch', () => {
  const stubFetch = (impl: (url: string) => Promise<unknown>) => {
    const fetch = vi.fn(impl)
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('answers the certificate’s text', async () => {
    const fetch = stubFetch(async () => ({ ok: true, status: 200, text: async () => pem }))
    expect(await fetchCertificate(CERT_URL)).toBe(pem)
    expect(fetch).toHaveBeenCalledWith(
      CERT_URL,
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it('is unreachable when the host does not answer, or answers 5xx', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(fetchCertificate(CERT_URL)).rejects.toBeInstanceOf(CertificateUnreachable)
    stubFetch(async () => ({ ok: false, status: 503, text: async () => '' }))
    await expect(fetchCertificate(CERT_URL)).rejects.toBeInstanceOf(CertificateUnreachable)
  })

  it('is a refusal when the host has no such certificate', async () => {
    stubFetch(async () => ({ ok: false, status: 404, text: async () => '' }))
    await expect(fetchCertificate(CERT_URL)).rejects.toThrow('certificate: HTTP 404')
  })

  it('is what verification uses when none is passed', async () => {
    stubFetch(async () => ({ ok: true, status: 200, text: async () => pem }))
    expect(await verifySnsMessage(await notification(), { topicArn: TOPIC })).toMatchObject({
      ok: true,
    })
  })
})

describe('confirming the subscription', () => {
  it('visits SubscribeURL when it is on the same SNS host', async () => {
    const fetch = vi.fn(async (_url: string) => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const verdict = await verify(await confirmation())
    if (!verdict.ok) throw new Error('not verified')
    expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('confirmed')
    expect(fetch.mock.calls[0]?.[0]).toBe(SUBSCRIBE_URL)
  })

  it('never visits a SubscribeURL anywhere else, however well signed', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const url of [
      'https://attacker.example/?Action=ConfirmSubscription',
      `http://${HOST}/?Action=ConfirmSubscription`,
      'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
    ]) {
      const verdict = await verify(await confirmation({ SubscribeURL: url }))
      if (!verdict.ok) throw new Error('not verified')
      expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('refused')
    }
    const verdict = await verify(await notification())
    if (!verdict.ok) throw new Error('not verified')
    expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('refused')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a confirmation SNS did not accept', async () => {
    const verdict = await verify(await confirmation())
    if (!verdict.ok) throw new Error('not verified')
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 403 }))
    expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('failed')
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('failed')
  })
})
