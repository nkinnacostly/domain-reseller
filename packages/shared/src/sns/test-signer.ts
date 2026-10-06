import { toBase64 } from '../ses/base64'
import { utf8 } from '../ses/platform'

/**
 * A stand-in for Amazon SNS in tests: its own RSA key pair and a signer that
 * builds the string to sign from AWS's documentation — deliberately not from
 * the verifier, so the two are checked against each other rather than
 * against themselves — plus a minimal X.509 encoder, so the verifier's
 * certificate reader meets both a v3 and a v1 certificate around a key the
 * test holds. Web Crypto only, as the verifier.
 */

type Key = { readonly type: string }
type Rsa = { name: 'RSASSA-PKCS1-v1_5'; hash: 'SHA-1' | 'SHA-256' }
type Subtle = {
  generateKey(
    algorithm: Rsa & { modulusLength: number; publicExponent: Uint8Array },
    extractable: true,
    usages: ['sign', 'verify'],
  ): Promise<{ publicKey: Key; privateKey: Key }>
  exportKey(format: 'spki' | 'pkcs8', key: Key): Promise<ArrayBuffer>
  importKey(
    format: 'pkcs8',
    key: Uint8Array,
    algorithm: Rsa,
    extractable: false,
    usages: ['sign'],
  ): Promise<Key>
  sign(algorithm: 'RSASSA-PKCS1-v1_5', key: Key, data: Uint8Array): Promise<ArrayBuffer>
}
const subtle = () => (globalThis as unknown as { crypto: { subtle: Subtle } }).crypto.subtle

export type TestKeys = { spki: Uint8Array; pkcs8: Uint8Array }

export async function generateTestKeys(modulusLength = 1024): Promise<TestKeys> {
  const pair = await subtle().generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )
  return {
    spki: new Uint8Array(await subtle().exportKey('spki', pair.publicKey)),
    pkcs8: new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey)),
  }
}

export function toPem(label: 'CERTIFICATE' | 'PUBLIC KEY', der: Uint8Array): string {
  const lines = toBase64(der).match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

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

export type Fields = Record<string, string | undefined>

export async function signSns(
  fields: Fields,
  keys: TestKeys,
  { version = '2', certUrl }: { version?: '1' | '2'; certUrl?: string } = {},
): Promise<Fields> {
  const order = fields.Type === 'Notification' ? NOTIFICATION : SUBSCRIPTION
  let text = ''
  for (const name of order) {
    const value = fields[name]
    if (value !== undefined) text += `${name}\n${value}\n`
  }
  const key = await subtle().importKey(
    'pkcs8',
    keys.pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: version === '1' ? 'SHA-1' : 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await subtle().sign('RSASSA-PKCS1-v1_5', key, utf8(text)))
  return {
    ...fields,
    SignatureVersion: version,
    Signature: toBase64(signature),
    SigningCertURL: fields.SigningCertURL ?? certUrl,
  }
}

// ── A minimal DER encoder ──────────────────────────────────────────────────

function lengthBytes(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256)
  return [0x80 | bytes.length, ...bytes]
}

export function der(tag: number, ...contents: Uint8Array[]): Uint8Array {
  const body = contents.flatMap((part) => [...part])
  return new Uint8Array([tag, ...lengthBytes(body.length), ...body])
}

const seq = (...parts: Uint8Array[]) => der(0x30, ...parts)
const int = (value: number) => der(0x02, new Uint8Array([value]))
const oid = der(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]))
const time = (text: string) => der(0x17, utf8(text))

/**
 * A certificate around `spki`, its signature not a real one: the verifier
 * trusts the host that serves a certificate, never its chain (as the shop).
 */
export function testCertificate(
  spki: Uint8Array,
  { v1 = false }: { v1?: boolean } = {},
): Uint8Array {
  const tbs = seq(
    ...(v1 ? [] : [der(0xa0, int(2))]),
    int(7),
    seq(oid),
    seq(),
    seq(time('260101000000Z'), time('360101000000Z')),
    seq(),
    spki,
  )
  return seq(tbs, seq(oid), der(0x03, new Uint8Array([0, 1, 2, 3])))
}
