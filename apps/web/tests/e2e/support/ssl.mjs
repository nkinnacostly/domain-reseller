/**
 * Stand-in certificate text for the SSL journeys (FR-SSL-4, FR-SSL-7). A
 * real CSR carries its name in ASN.1; a test one carries it readably, so the
 * mock gateway's check-csr can read it back. Kept apart from
 * mock-gateway.mjs, which starts its server when imported.
 */

/** A CSR-shaped block naming `name`, as e2e pastes it and the mock generates it. */
export function mockCsr(name) {
  const body = Buffer.from(`MOCKCSR:${name}:${'x'.repeat(120)}`).toString('base64')
  return `-----BEGIN CERTIFICATE REQUEST-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE REQUEST-----`
}

/** The name in a `mockCsr` block, or null for anything else. */
export function mockCsrName(csr) {
  const body = String(csr)
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s+/g, '')
  const text = Buffer.from(body, 'base64').toString('latin1')
  return /^MOCKCSR:([^:]+):/.exec(text)?.[1] ?? null
}

/** A certificate-shaped block, as the poller would store it once issued. */
export function mockCertificate(label) {
  const body = Buffer.from(`MOCKCERT:${label}:${'y'.repeat(180)}`).toString('base64')
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`
}
