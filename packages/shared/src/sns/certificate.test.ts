import { describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from '../ses/base64'
import { certificateSpki, spkiFromPem } from './certificate'
import { FIXTURE_CERTIFICATE_PEM, FIXTURE_PUBLIC_KEY_PEM } from './test-fixtures'
import { der, generateTestKeys, testCertificate, toPem } from './test-signer'

/**
 * The certificate reader: an X.509 certificate's public key, exactly as
 * OpenSSL reads it, for v3 and v1 certificates — and nothing at all from
 * anything that is not one.
 */

const derOf = (pem: string) => fromBase64(pem.replace(/-----[^-]+-----/g, '')) as Uint8Array

describe('reading the key in an SNS certificate', () => {
  it('finds the same public key OpenSSL reads from a real certificate', () => {
    const spki = spkiFromPem(FIXTURE_CERTIFICATE_PEM)
    expect(spki).not.toBeNull()
    expect(toBase64(spki as Uint8Array)).toBe(toBase64(derOf(FIXTURE_PUBLIC_KEY_PEM)))
  })

  it('reads a bare public key as it is', () => {
    expect(toBase64(spkiFromPem(FIXTURE_PUBLIC_KEY_PEM) as Uint8Array)).toBe(
      toBase64(derOf(FIXTURE_PUBLIC_KEY_PEM)),
    )
  })

  it('reads v3 and v1 certificates alike', async () => {
    const { spki } = await generateTestKeys()
    for (const v1 of [false, true]) {
      const pem = toPem('CERTIFICATE', testCertificate(spki, { v1 }))
      expect(toBase64(spkiFromPem(pem) as Uint8Array)).toBe(toBase64(spki))
    }
  })

  it.each([
    ['nothing', ''],
    ['a PEM of another kind', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'],
    ['mismatched markers', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END PUBLIC KEY-----'],
    ['an empty body', '-----BEGIN CERTIFICATE-----\n=\n-----END CERTIFICATE-----'],
    ['broken base64', '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'],
  ])('reads no key from %s', (_label, pem) => {
    expect(spkiFromPem(pem)).toBeNull()
  })

  it('refuses DER that is not a certificate', async () => {
    const { spki } = await generateTestKeys()
    const real = testCertificate(spki)
    const seq = (...parts: Uint8Array[]) => der(0x30, ...parts)
    const int = der(0x02, new Uint8Array([1]))
    const cases: Uint8Array[] = [
      new Uint8Array([]),
      new Uint8Array([0x30]),
      // Truncated, and with something after the certificate.
      real.slice(0, real.length - 5),
      new Uint8Array([...real, 0]),
      // Not a SEQUENCE, outside or inside.
      der(0x31, real.slice(2)),
      seq(der(0x31, int)),
      // BER's indefinite length, and a length of five bytes.
      new Uint8Array([0x30, 0x80, 0, 0]),
      new Uint8Array([0x30, 0x85, 0, 0, 0, 0, 1, 0]),
      // A length past its parent.
      seq(new Uint8Array([0x30, 0x10, 0])),
      // No serial number where one belongs.
      seq(seq(seq(), seq(), seq(), seq(), seq(), seq(), seq())),
      // Too few fields, and a field of the wrong kind before the key.
      seq(seq(int, seq(), seq(), seq())),
      seq(seq(int, seq(), seq(), der(0x04, int), seq(), spki)),
      // A key field that is not a SEQUENCE.
      seq(seq(int, seq(), seq(), seq(), seq(), der(0x04, int))),
    ]
    for (const bytes of cases) expect(certificateSpki(bytes)).toBeNull()
  })

  it('reads long-form lengths', async () => {
    const { spki } = await generateTestKeys(2048)
    expect(toBase64(certificateSpki(testCertificate(spki)) as Uint8Array)).toBe(toBase64(spki))
  })
})
