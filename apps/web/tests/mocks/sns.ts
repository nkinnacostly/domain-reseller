import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

/**
 * A stand-in for Amazon SNS in tests: its own RSA key pair, whose public half
 * the MSW handler serves at SNS_CERT_URL, and a signer that builds the string
 * to sign from AWS's documentation — deliberately not from our verifier, so
 * the two are checked against each other rather than against themselves.
 * Generated on first use, so test files that never sign pay nothing.
 */

export const SNS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:123456789012:mydomainshub-ses-events'
export const SNS_HOST = 'sns.eu-west-2.amazonaws.com'
export const SNS_CERT_URL = `https://${SNS_HOST}/SimpleNotificationService-0000test.pem`
export const SNS_SUBSCRIBE_URL = `https://${SNS_HOST}/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(SNS_TOPIC_ARN)}&Token=2336412f37fb687f5d51e6e2425c464de`

let keys: { privateKey: KeyObject; publicKey: KeyObject } | null = null

export function snsKeys() {
  keys ??= generateKeyPairSync('rsa', { modulusLength: 1024 })
  return keys
}

/** What the handler serves: `createPublicKey` reads a key as it reads a certificate. */
export const snsPublicKeyPem = () =>
  snsKeys().publicKey.export({ type: 'spki', format: 'pem' }).toString()

type Fields = Record<string, string | undefined>

// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
const NOTIFICATION = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
const SUBSCRIPTION = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
]

export function signSns(
  fields: Fields,
  { version = '2', key = snsKeys().privateKey }: { version?: '1' | '2'; key?: KeyObject } = {},
): Fields {
  const order = fields.Type === 'Notification' ? NOTIFICATION : SUBSCRIPTION
  let text = ''
  for (const name of order) {
    const value = fields[name]
    if (value !== undefined) text += `${name}\n${value}\n`
  }
  const signature = sign(version === '1' ? 'sha1' : 'sha256', Buffer.from(text), key)
  return {
    ...fields,
    SignatureVersion: version,
    Signature: signature.toString('base64'),
    SigningCertURL: fields.SigningCertURL ?? SNS_CERT_URL,
  }
}

/** An SNS Notification carrying one SES event, signed. */
export function snsNotification(sesEvent: unknown, over: Fields = {}, version: '1' | '2' = '2') {
  return signSns(
    {
      Type: 'Notification',
      MessageId: 'b0a6a5c5-2f1e-5d1e-9c1e-0000000000aa',
      TopicArn: SNS_TOPIC_ARN,
      Message: typeof sesEvent === 'string' ? sesEvent : JSON.stringify(sesEvent),
      Timestamp: '2026-09-25T08:00:01.000Z',
      UnsubscribeURL: `https://${SNS_HOST}/?Action=Unsubscribe&SubscriptionArn=x`,
      ...over,
    },
    { version },
  )
}

/** SES event publishing's shape, with an address everywhere SES would put one. */
export function sesEvent(
  eventType: string,
  messageId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    eventType,
    mail: {
      timestamp: '2026-09-25T07:59:58.000Z',
      source: 'MyDomainsHub <no-reply@notify.mydomainshub.com>',
      sendingAccountId: '123456789012',
      messageId,
      destination: ['ada@gmail.com'],
      headersTruncated: false,
      headers: [{ name: 'To', value: 'ada@gmail.com' }],
      commonHeaders: { to: ['ada@gmail.com'], subject: 'Your .com expires in 30 days' },
      tags: { category: ['compliance'], kind: ['expiry_notice'] },
    },
    ...extra,
  }
}
