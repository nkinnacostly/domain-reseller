import { fromBase64 } from '../ses/base64'

/**
 * The public key in an SNS signing certificate, as Web Crypto imports it
 * (SubjectPublicKeyInfo, DER). `packages/shared` has no Node `crypto`, and
 * Web Crypto cannot read an X.509 certificate, so the certificate's DER is
 * walked to its seventh field — RFC 5280 §4.1:
 *
 *   Certificate  ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *   TBSCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature,
 *                                 issuer, validity, subject, subjectPublicKeyInfo, … }
 *
 * Nothing in the certificate is trusted but its key: SNS's verifier takes
 * the certificate only from the topic region's own SNS host (sns.ts), as the
 * shop's did. A bare `PUBLIC KEY` PEM is read as it is, as Node's
 * `createPublicKey` read both.
 */

type Tlv = { tag: number; start: number; contentStart: number; end: number }

/** One DER element at `at`: definite lengths only, inside `limit`. */
function readTlv(der: Uint8Array, at: number, limit: number): Tlv | null {
  if (at + 2 > limit) return null
  const tag = der[at] as number
  const first = der[at + 1] as number
  let length = first
  let contentStart = at + 2
  if (first & 0x80) {
    const bytes = first & 0x7f
    // 0x80 is BER's indefinite length, never DER; four bytes is 4 GB.
    if (bytes === 0 || bytes > 4 || at + 2 + bytes > limit) return null
    length = 0
    for (let i = 0; i < bytes; i++) length = length * 256 + (der[at + 2 + i] as number)
    contentStart = at + 2 + bytes
  }
  const end = contentStart + length
  if (end > limit) return null
  return { tag, start: at, contentStart, end }
}

const SEQUENCE = 0x30
const VERSION = 0xa0
const INTEGER = 0x02

/** The SubjectPublicKeyInfo element of an X.509 certificate's DER, or null. */
export function certificateSpki(der: Uint8Array): Uint8Array | null {
  const certificate = readTlv(der, 0, der.length)
  if (!certificate || certificate.tag !== SEQUENCE || certificate.end !== der.length) return null
  const tbs = readTlv(der, certificate.contentStart, certificate.end)
  if (!tbs || tbs.tag !== SEQUENCE) return null
  const fields: Tlv[] = []
  for (let at = tbs.contentStart; at < tbs.end && fields.length < 8; ) {
    const field = readTlv(der, at, tbs.end)
    if (!field) return null
    fields.push(field)
    at = field.end
  }
  // A v1 certificate leaves the version out; then the serial number leads.
  const rest = fields[0]?.tag === VERSION ? fields.slice(1) : fields
  if (rest[0]?.tag !== INTEGER) return null
  const spki = rest[5]
  if (!spki || spki.tag !== SEQUENCE || rest.slice(1, 5).some((f) => f.tag !== SEQUENCE)) {
    return null
  }
  return der.slice(spki.start, spki.end)
}

const PEM = /-----BEGIN (CERTIFICATE|PUBLIC KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----/

/** The SubjectPublicKeyInfo DER in a certificate or public-key PEM, or null. */
export function spkiFromPem(pem: string): Uint8Array | null {
  const match = PEM.exec(pem)
  if (!match) return null
  const der = fromBase64(match[2] ?? '')
  if (!der || der.length === 0) return null
  return match[1] === 'PUBLIC KEY' ? der : certificateSpki(der)
}
