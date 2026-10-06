import { fromBase64 } from '../ses/base64'
import { timeoutSignal, utf8 } from '../ses/platform'
import { spkiFromPem } from './certificate'

/**
 * Amazon SNS message signatures: how an endpoint knows a pushed message
 * really came from its own topic — the shop's SES delivery events
 * (/api/email/ses-events, L1) and Mail's SES events and tenant status
 * (/api/ses/events, MAIL-SPEC §4.2). Anyone can POST to either; only a
 * message AWS signed for that exact topic is acted on.
 *
 *   - `TopicArn` must be the configured topic (it is covered by the signature);
 *   - `SigningCertURL` must be https on `sns.<topic's region>.amazonaws.com`,
 *     a `.pem` file — never a host the sender chose;
 *   - the signature (v1 SHA1withRSA, v2 SHA256withRSA) must verify over the
 *     documented fields, in order, for the message's type.
 *
 * Moved here from the shop (apps/web) for Mail's second use, unchanged in
 * behaviour; Web Crypto instead of Node's `crypto`, as the rest of this
 * package. Certificates are fetched once per URL and kept for the life of
 * the process. The fetch is injectable so tests sign with their own key pair
 * (a certificate or a bare public key are read alike).
 */

export type SnsType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'

export type SnsMessage = {
  Type: SnsType
  MessageId: string
  TopicArn: string
  Message: string
  Timestamp: string
  SignatureVersion: '1' | '2'
  Signature: string
  SigningCertURL: string
  Subject?: string
  SubscribeURL?: string
  Token?: string
}

export type SnsRefusal =
  /** Not an SNS message, or missing what its type needs. */
  | 'malformed'
  /** Signed, perhaps, but for some other topic. */
  | 'wrong_topic'
  /** The certificate is not on the topic region's SNS host. */
  | 'bad_certificate_url'
  /** SNS's host did not serve a certificate there. */
  | 'bad_certificate'
  /** SNS's host could not be reached: a retry may verify it. */
  | 'certificate_unreachable'
  | 'bad_signature'

export type SnsVerdict =
  | { ok: true; message: SnsMessage; snsHost: string }
  | { ok: false; reason: SnsRefusal }

/** Resolves to the PEM at `url`; rejects with CertificateUnreachable when the host cannot answer. */
export type CertificateFetch = (url: string) => Promise<string>

export class CertificateUnreachable extends Error {
  constructor() {
    super('SNS certificate host unreachable')
    this.name = 'CertificateUnreachable'
  }
}

/** The few Web Platform globals used here, typed without the DOM library. */
type RsaKey = { readonly type: string }
type RsaAlgorithm = { name: 'RSASSA-PKCS1-v1_5'; hash: 'SHA-1' | 'SHA-256' }
type Web = {
  crypto: {
    subtle: {
      importKey(
        format: 'spki',
        key: Uint8Array,
        algorithm: RsaAlgorithm,
        extractable: false,
        usages: ['verify'],
      ): Promise<RsaKey>
      verify(
        algorithm: 'RSASSA-PKCS1-v1_5',
        key: RsaKey,
        signature: Uint8Array,
        data: Uint8Array,
      ): Promise<boolean>
    }
  }
  URL: new (
    url: string,
  ) => {
    protocol: string
    hostname: string
    port: string
    username: string
    password: string
    pathname: string
    search: string
    hash: string
  }
  fetch(
    url: string,
    init: { signal: unknown },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>
}
const web = globalThis as unknown as Web

/** The fields each type signs, in the order AWS documents. */
const SIGNED_FIELDS: Record<SnsType, readonly (keyof SnsMessage)[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
}

const TOPIC_ARN = /^arn:aws:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/
const CERT_TIMEOUT_MS = 5_000
const MAX_CACHED = 20

/** `Key\nValue\n` for each signed field present — Subject is signed only when sent. */
export function snsStringToSign(message: SnsMessage): string {
  return SIGNED_FIELDS[message.Type]
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join('')
}

/** `sns.eu-west-2.amazonaws.com` for a topic in eu-west-2; null for a malformed ARN. */
export function snsHostFor(topicArn: string): string | null {
  const region = TOPIC_ARN.exec(topicArn)?.[1]
  return region ? `sns.${region}.amazonaws.com` : null
}

/** An https URL on exactly `host`, default port, no credentials. */
export function isOnHost(value: string, host: string, path?: RegExp): boolean {
  let url: InstanceType<Web['URL']>
  try {
    url = new web.URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === host &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    (!path || (path.test(url.pathname) && url.search === '' && url.hash === ''))
  )
}

function parseMessage(raw: unknown): SnsMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null)
  const type = text('Type')
  const version = text('SignatureVersion')
  if (
    type !== 'Notification' &&
    type !== 'SubscriptionConfirmation' &&
    type !== 'UnsubscribeConfirmation'
  ) {
    return null
  }
  if (version !== '1' && version !== '2') return null
  const required = ['MessageId', 'TopicArn', 'Message', 'Timestamp', 'Signature', 'SigningCertURL']
  if (type !== 'Notification') required.push('SubscribeURL', 'Token')
  if (required.some((key) => text(key) === null)) return null
  // Subject is optional, but if present it must be a string to be signed.
  if (record.Subject !== undefined && record.Subject !== null && text('Subject') === null)
    return null

  const message: SnsMessage = {
    Type: type,
    MessageId: text('MessageId') as string,
    TopicArn: text('TopicArn') as string,
    Message: text('Message') as string,
    Timestamp: text('Timestamp') as string,
    SignatureVersion: version,
    Signature: text('Signature') as string,
    SigningCertURL: text('SigningCertURL') as string,
  }
  const subject = text('Subject')
  if (subject !== null && type === 'Notification') message.Subject = subject
  if (type !== 'Notification') {
    message.SubscribeURL = text('SubscribeURL') as string
    message.Token = text('Token') as string
  }
  return message
}

export const fetchCertificate: CertificateFetch = async (url) => {
  let response: Awaited<ReturnType<Web['fetch']>>
  try {
    response = await web.fetch(url, { signal: timeoutSignal(CERT_TIMEOUT_MS) })
  } catch {
    throw new CertificateUnreachable()
  }
  if (response.status >= 500) throw new CertificateUnreachable()
  if (!response.ok) throw new Error(`certificate: HTTP ${response.status}`)
  return response.text()
}

/** Each certificate's public key (SubjectPublicKeyInfo, DER), by URL. */
const certificates = new Map<string, Uint8Array>()

/** Forgets cached certificates (tests). */
export function clearCertificateCache() {
  certificates.clear()
}

const rsa = (hash: RsaAlgorithm['hash']): RsaAlgorithm => ({ name: 'RSASSA-PKCS1-v1_5', hash })

async function importRsa(spki: Uint8Array, hash: RsaAlgorithm['hash']): Promise<RsaKey | null> {
  try {
    return await web.crypto.subtle.importKey('spki', spki, rsa(hash), false, ['verify'])
  } catch {
    return null
  }
}

async function publicKeyAt(
  url: string,
  fetchPem: CertificateFetch,
): Promise<Uint8Array | 'unreachable' | 'bad'> {
  const cached = certificates.get(url)
  if (cached) return cached
  let pem: string
  try {
    pem = await fetchPem(url)
  } catch (error) {
    return error instanceof CertificateUnreachable ? 'unreachable' : 'bad'
  }
  const spki = spkiFromPem(pem)
  // Only an RSA key imports as RSASSA-PKCS1-v1_5: anything else is no SNS certificate.
  if (!spki || !(await importRsa(spki, 'SHA-256'))) return 'bad'
  if (certificates.size >= MAX_CACHED) certificates.clear()
  certificates.set(url, spki)
  return spki
}

export async function verifySnsMessage(
  raw: unknown,
  options: { topicArn: string; fetchCertificate?: CertificateFetch },
): Promise<SnsVerdict> {
  const message = parseMessage(raw)
  if (!message) return { ok: false, reason: 'malformed' }
  const snsHost = snsHostFor(options.topicArn)
  if (!snsHost || message.TopicArn !== options.topicArn) return { ok: false, reason: 'wrong_topic' }
  if (!isOnHost(message.SigningCertURL, snsHost, /^\/[A-Za-z0-9._-]+\.pem$/)) {
    return { ok: false, reason: 'bad_certificate_url' }
  }

  const spki = await publicKeyAt(
    message.SigningCertURL,
    options.fetchCertificate ?? fetchCertificate,
  )
  if (spki === 'unreachable') return { ok: false, reason: 'certificate_unreachable' }
  if (spki === 'bad') return { ok: false, reason: 'bad_certificate' }

  const key = await importRsa(spki, message.SignatureVersion === '1' ? 'SHA-1' : 'SHA-256')
  const signature = fromBase64(message.Signature)
  let valid = false
  if (key && signature) {
    try {
      valid = await web.crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        signature,
        utf8(snsStringToSign(message)),
      )
    } catch {
      valid = false
    }
  }
  return valid ? { ok: true, message, snsHost } : { ok: false, reason: 'bad_signature' }
}

/**
 * Accepts the subscription by visiting its SubscribeURL — only when that URL
 * is on the same SNS host the signature was checked against.
 */
export async function confirmSubscription(
  message: SnsMessage,
  snsHost: string,
): Promise<'confirmed' | 'refused' | 'failed'> {
  const url = message.SubscribeURL
  if (!url || !isOnHost(url, snsHost)) return 'refused'
  try {
    const response = await web.fetch(url, { signal: timeoutSignal(CERT_TIMEOUT_MS) })
    return response.ok ? 'confirmed' : 'failed'
  } catch {
    return 'failed'
  }
}
