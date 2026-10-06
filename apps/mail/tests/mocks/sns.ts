import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'

/**
 * A stand-in for Amazon SNS in Mail's tests (and e2e): its own RSA key pair,
 * whose public half a test serves at SNS_CERT_URL, and a signer that builds
 * the string to sign from AWS's documentation — deliberately not from the
 * verifier, so the two are checked against each other. Payloads follow the
 * SES developer guide's event publishing examples and the tenants chapter's
 * EventBridge examples, with an address everywhere SES would put one.
 */

export const SNS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:123456789012:mail-ses-events'
export const SNS_HOST = 'sns.eu-west-2.amazonaws.com'
export const SNS_CERT_URL = `https://${SNS_HOST}/SimpleNotificationService-0000mail.pem`
export const SNS_SUBSCRIBE_URL = `https://${SNS_HOST}/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(SNS_TOPIC_ARN)}&Token=2336412f37fb687f`

let keys: { privateKey: KeyObject; publicKey: KeyObject } | null = null

export function snsKeys() {
  keys ??= generateKeyPairSync('rsa', { modulusLength: 1024 })
  return keys
}

export const snsPublicKeyPem = () =>
  snsKeys().publicKey.export({ type: 'spki', format: 'pem' }).toString()

export type Fields = Record<string, string | undefined>

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
  {
    version = '2',
    key = snsKeys().privateKey,
    certUrl = SNS_CERT_URL,
  }: { version?: '1' | '2'; key?: KeyObject; certUrl?: string } = {},
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
    SigningCertURL: fields.SigningCertURL ?? certUrl,
  }
}

let sequence = 0

/** An SNS Notification carrying one message, signed. */
export function snsNotification(
  message: unknown,
  over: Fields = {},
  options: Parameters<typeof signSns>[1] = {},
) {
  sequence += 1
  return signSns(
    {
      Type: 'Notification',
      MessageId: `b0a6a5c5-2f1e-5d1e-9c1e-${String(sequence).padStart(12, '0')}`,
      TopicArn: SNS_TOPIC_ARN,
      Message: typeof message === 'string' ? message : JSON.stringify(message),
      Timestamp: '2026-10-06T08:00:01.000Z',
      UnsubscribeURL: `https://${SNS_HOST}/?Action=Unsubscribe&SubscriptionArn=x`,
      ...over,
    },
    options,
  )
}

export function snsConfirmation(over: Fields = {}, options: Parameters<typeof signSns>[1] = {}) {
  return signSns(
    {
      Type: 'SubscriptionConfirmation',
      MessageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b',
      Token: '2336412f37fb687f',
      TopicArn: SNS_TOPIC_ARN,
      Message: `You have chosen to subscribe to the topic ${SNS_TOPIC_ARN}.`,
      SubscribeURL: SNS_SUBSCRIBE_URL,
      Timestamp: '2026-10-06T08:00:00.000Z',
      ...over,
    },
    options,
  )
}

/** SES event publishing's shape, with Mail's tags and an address everywhere SES puts one. */
export function sesEvent(
  eventType: string,
  messageId: string,
  extra: Record<string, unknown> = {},
  {
    emailId = '7d2f0c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
    to = 'ada@example.com',
  }: { emailId?: string; to?: string } = {},
) {
  return {
    eventType,
    mail: {
      timestamp: '2026-10-06T07:59:58.000Z',
      source: 'Acme <receipts@acme.example>',
      sendingAccountId: '123456789012',
      messageId,
      destination: [to],
      headersTruncated: false,
      headers: [{ name: 'To', value: to }],
      commonHeaders: { to: [to], subject: 'Your receipt' },
      tags: {
        'ses:configuration-set': ['mdm-0a1b2c3d4e'],
        'ses:tenant-name': ['mdm-0a1b2c3d4e'],
        mdm_email: [emailId],
        mdm_account: ['0a1b2c3d4e'],
      },
    },
    ...extra,
  }
}

/** EventBridge's tenant events, as SES's tenants chapter shows them. */
export function tenantStatusEvent(
  status: 'ENABLED' | 'DISABLED' | 'REINSTATED',
  {
    id = 'e5f2b1c0-1111-2222-3333-444455556666',
    tenant = 'mdm-0a1b2c3d4e',
    at = [2026, 10, 6, 8, 0, 0, 995000000] as number[],
  } = {},
) {
  return {
    version: '0',
    id,
    'detail-type': status === 'DISABLED' ? 'Sending Status Disabled' : 'Sending Status Enabled',
    source: 'aws.ses',
    account: '123456789012',
    time: '2026-10-06T08:00:01Z',
    region: 'eu-west-2',
    resources: [`arn:aws:ses:eu-west-2:123456789012:tenant/${tenant}/tn-0a1b2c3d`],
    detail: {
      version: '1.0.0',
      data: {
        origin: 'AWS_MANAGED',
        record: { status, cause: 'Status updated by reputation policy.', lastUpdatedTimestamp: at },
      },
    },
  }
}

export function advisorEvent(
  state: 'Open' | 'Resolved',
  {
    id = 'a1b2c3d4-1111-2222-3333-444455556666',
    resource = 'arn:aws:ses:eu-west-2:123456789012:tenant/mdm-0a1b2c3d4e/tn-0a1b2c3d',
    data = 'The bounce rate exceeded 15.0% based on a representative volume of 197 emails.',
    metadata = { impact: 'HIGH', type: 'BOUNCE' } as Record<string, string> | undefined,
  } = {},
) {
  return {
    version: '0',
    id,
    'detail-type': `Advisor Recommendation Status ${state}`,
    source: 'aws.ses',
    account: '123456789012',
    time: '2026-10-06T08:00:59Z',
    region: 'eu-west-2',
    resources: [resource],
    detail: { version: '1.0.0', data, ...(metadata ? { metadata } : {}) },
  }
}
