import { generateKeyPairSync } from 'node:crypto'
import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'
import {
  SNS_CERT_URL,
  SNS_HOST,
  SNS_SUBSCRIBE_URL,
  SNS_TOPIC_ARN,
  sesEvent,
  signSns,
  snsNotification,
  snsPublicKeyPem,
} from '../../../../tests/mocks/sns'
import {
  CertificateUnreachable,
  clearCertificateCache,
  confirmSubscription,
  isOnHost,
  snsHostFor,
  snsStringToSign,
  verifySnsMessage,
} from '../sns'

const verify = (raw: unknown, fetchCertificate?: (url: string) => Promise<string>) =>
  verifySnsMessage(raw, {
    topicArn: SNS_TOPIC_ARN,
    ...(fetchCertificate ? { fetchCertificate } : {}),
  })

const EVENT = sesEvent('Delivery', '0102-abc-000000', {
  delivery: { timestamp: '2026-09-25T08:00:00.000Z' },
})

const confirmation = (over: Record<string, string> = {}) =>
  signSns({
    Type: 'SubscriptionConfirmation',
    MessageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b',
    Token: '2336412f37fb687f5d51e6e2425c464de',
    TopicArn: SNS_TOPIC_ARN,
    Message: `You have chosen to subscribe to the topic ${SNS_TOPIC_ARN}.`,
    SubscribeURL: SNS_SUBSCRIBE_URL,
    Timestamp: '2026-09-25T08:00:00.000Z',
    ...over,
  })

beforeEach(() => clearCertificateCache())

describe('SNS signatures (L1)', () => {
  it('accepts a notification signed with SignatureVersion 2 (SHA256withRSA)', async () => {
    const verdict = await verify(snsNotification(EVENT))
    expect(verdict).toMatchObject({ ok: true, snsHost: SNS_HOST })
    expect(verdict.ok && verdict.message.Type).toBe('Notification')
  })

  it('accepts a notification signed with SignatureVersion 1 (SHA1withRSA)', async () => {
    expect(await verify(snsNotification(EVENT, {}, '1'))).toMatchObject({ ok: true })
  })

  it('signs the Subject when there is one, and only then', async () => {
    expect(
      await verify(snsNotification(EVENT, { Subject: 'Amazon SES Email Event' })),
    ).toMatchObject({
      ok: true,
    })
    const signed = snsNotification(EVENT, { Subject: 'Amazon SES Email Event' })
    expect(await verify({ ...signed, Subject: 'Something else' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
    // Dropping a signed Subject changes what was signed, too.
    const { Subject: _dropped, ...withoutSubject } = signed
    expect(await verify(withoutSubject)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('accepts a subscription confirmation over its own fields', async () => {
    expect(await verify(confirmation())).toMatchObject({ ok: true })
  })

  it.each([
    ['Message', JSON.stringify(sesEvent('Bounce', '0102-abc-000000'))],
    ['MessageId', 'another-id'],
    ['Timestamp', '2026-09-26T08:00:01.000Z'],
    ['Type', 'SubscriptionConfirmation'],
  ])('refuses a notification whose %s was changed after signing', async (field, value) => {
    const verdict = await verify({ ...snsNotification(EVENT), [field]: value })
    expect(verdict.ok).toBe(false)
  })

  it('refuses a signature made with someone else’s key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
    const forged = signSns(
      { ...snsNotification(EVENT), Signature: undefined, SignatureVersion: undefined },
      { key: privateKey },
    )
    expect(await verify(forged)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await verify({ ...snsNotification(EVENT), Signature: 'not base64 at all!' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('refuses a message for another topic, even one validly signed', async () => {
    const other = 'arn:aws:sns:eu-west-2:123456789012:someone-else'
    expect(await verify(snsNotification(EVENT, { TopicArn: other }))).toEqual({
      ok: false,
      reason: 'wrong_topic',
    })
    expect(await verifySnsMessage(snsNotification(EVENT), { topicArn: 'not an arn' })).toEqual({
      ok: false,
      reason: 'wrong_topic',
    })
  })

  it.each([
    ['plain http', `http://${SNS_HOST}/SimpleNotificationService-0000test.pem`],
    ['another host', 'https://attacker.example/SimpleNotificationService-0000test.pem'],
    ['a look-alike host', `https://${SNS_HOST}.attacker.example/cert.pem`],
    ['another region', 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem'],
    ['a port', `https://${SNS_HOST}:8443/SimpleNotificationService-x.pem`],
    ['credentials', `https://user:pass@${SNS_HOST}/SimpleNotificationService-x.pem`],
    ['not a .pem', `https://${SNS_HOST}/SimpleNotificationService-x.txt`],
    ['a query', `https://${SNS_HOST}/SimpleNotificationService-x.pem?x=1`],
    ['a nested path', `https://${SNS_HOST}/a/SimpleNotificationService-x.pem`],
    ['not a URL', 'nonsense'],
  ])('refuses a certificate URL with %s, before fetching anything', async (_label, url) => {
    const fetchCertificate = vi.fn(async () => snsPublicKeyPem())
    expect(await verify(snsNotification(EVENT, { SigningCertURL: url }), fetchCertificate)).toEqual(
      {
        ok: false,
        reason: 'bad_certificate_url',
      },
    )
    expect(fetchCertificate).not.toHaveBeenCalled()
  })

  it.each([
    ['nothing', null],
    ['a string', 'hello'],
    ['an unknown type', { ...snsNotification(EVENT), Type: 'Surprise' }],
    ['an unknown signature version', { ...snsNotification(EVENT), SignatureVersion: '3' }],
    ['a missing field', { ...snsNotification(EVENT), MessageId: undefined }],
    ['a subject that is not text', { ...snsNotification(EVENT), Subject: 42 }],
    ['a confirmation without its token', { ...confirmation(), Token: undefined }],
  ])('refuses %s as malformed', async (_label, raw) => {
    expect(await verify(raw)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('fetches a certificate once, from SNS’s host, and keeps it', async () => {
    const fetchCertificate = vi.fn(async () => snsPublicKeyPem())
    await verify(snsNotification(EVENT), fetchCertificate)
    await verify(snsNotification(EVENT, { MessageId: 'second' }), fetchCertificate)
    expect(fetchCertificate).toHaveBeenCalledTimes(1)
    expect(fetchCertificate).toHaveBeenCalledWith(SNS_CERT_URL)
  })

  it('says when SNS’s certificate host could not be reached, so the message can come again', async () => {
    expect(
      await verify(snsNotification(EVENT), async () => {
        throw new CertificateUnreachable()
      }),
    ).toEqual({ ok: false, reason: 'certificate_unreachable' })
    server.use(http.get(`https://${SNS_HOST}/:certificate`, () => HttpResponse.error()))
    expect(await verify(snsNotification(EVENT))).toEqual({
      ok: false,
      reason: 'certificate_unreachable',
    })
    server.use(
      http.get(`https://${SNS_HOST}/:certificate`, () => new HttpResponse(null, { status: 503 })),
    )
    expect(await verify(snsNotification(EVENT))).toEqual({
      ok: false,
      reason: 'certificate_unreachable',
    })
  })

  it('refuses when the host serves no certificate, or not an RSA one', async () => {
    server.use(
      http.get(`https://${SNS_HOST}/:certificate`, () => new HttpResponse(null, { status: 404 })),
    )
    expect(await verify(snsNotification(EVENT))).toEqual({ ok: false, reason: 'bad_certificate' })
    expect(await verify(snsNotification(EVENT), async () => 'not a pem')).toEqual({
      ok: false,
      reason: 'bad_certificate',
    })
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString()
    expect(await verify(snsNotification(EVENT), async () => ec)).toEqual({
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
    expect(snsHostFor(SNS_TOPIC_ARN)).toBe('sns.eu-west-2.amazonaws.com')
    expect(snsHostFor('arn:aws:sns:eu-west-2:123:x')).toBeNull()
    expect(isOnHost('https://sns.eu-west-2.amazonaws.com/?a=1', SNS_HOST)).toBe(true)
  })
})

describe('confirming the subscription', () => {
  it('visits SubscribeURL when it is on the same SNS host', async () => {
    let visited: string | null = null
    server.use(
      http.get(`https://${SNS_HOST}/`, ({ request }) => {
        visited = request.url
        return HttpResponse.xml('<ConfirmSubscriptionResponse/>')
      }),
    )
    const verdict = await verify(confirmation())
    if (!verdict.ok) throw new Error('not verified')
    expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('confirmed')
    expect(new URL(visited ?? '').searchParams.get('Action')).toBe('ConfirmSubscription')
  })

  it('never visits a SubscribeURL anywhere else, however well signed', async () => {
    for (const url of [
      'https://attacker.example/?Action=ConfirmSubscription',
      `http://${SNS_HOST}/?Action=ConfirmSubscription`,
      'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
    ]) {
      const verdict = await verify(confirmation({ SubscribeURL: url }))
      if (!verdict.ok) throw new Error('not verified')
      expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('refused')
    }
  })

  it('reports a confirmation SNS did not accept', async () => {
    const verdict = await verify(confirmation())
    if (!verdict.ok) throw new Error('not verified')
    server.use(http.get(`https://${SNS_HOST}/`, () => new HttpResponse(null, { status: 403 })))
    expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('failed')
    server.use(http.get(`https://${SNS_HOST}/`, () => HttpResponse.error()))
    expect(await confirmSubscription(verdict.message, verdict.snsHost)).toBe('failed')
  })
})
