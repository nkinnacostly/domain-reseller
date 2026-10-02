import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { logger } from '../lib/logger'
import { TokenBucket } from '../lib/rate-limit'
import type { SslClient } from '../ssl/client'
import { createSslRoute } from './ssl'

/** FR-SSL-4: the set-up's reads, behind the gateway secret; a generated key leaves only in the answer (N13). */

const SECRET = process.env.GATEWAY_SHARED_SECRET as string
const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----'
const CSR =
  '-----BEGIN CERTIFICATE REQUEST-----\n' +
  'MIICozCCAYsCAQAwXjELMAkGA1UEBhMCTkcxDjAMBgNVBAgMBUxhZ29zMQ4wDAYDVQQHDAVJa2VqYTEUMBIGA1UECgwLRXhhbXBsZSBMdGQxGTAXBgNVBAMMEHNob3Au\n' +
  '-----END CERTIFICATE REQUEST-----'

function client(over: Partial<Record<keyof SslClient, unknown>> = {}) {
  const fn = (value: unknown) => vi.fn(async () => value)
  return {
    approvers: fn({ kind: 'found', data: ['admin@example.com'] }),
    checkCsr: fn({
      kind: 'found',
      data: {
        commonName: 'shop.example.com',
        alternativeNames: [],
        isWildcard: false,
        organization: null,
        country: 'NG',
      },
    }),
    generateCsr: fn({ kind: 'found', data: { csr: CSR, privateKey: KEY } }),
    ...Object.fromEntries(Object.entries(over).map(([key, value]) => [key, fn(value)])),
  } as unknown as SslClient & Record<string, ReturnType<typeof vi.fn>>
}

function app(ssl = client(), over: Parameters<typeof createSslRoute>[0] = {}) {
  return createApp({
    ssl: createSslRoute({ target: 'ote', client: () => ssl, ...over }),
  })
}

const call = (a: ReturnType<typeof app>, path: string, init: RequestInit = {}) =>
  a.request(`/v1/ssl${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })

const GENERATE = {
  name: 'example.com',
  alternativeNames: ['www.example.com'],
  country: 'NG',
  state: 'Lagos',
  locality: 'Ikeja',
  organization: 'Example Ltd',
  organizationUnit: 'IT',
}

describe('GET /v1/ssl/approvers', () => {
  it('lists the addresses the CA can write to, never cached', async () => {
    const ssl = client()
    const response = await call(app(ssl), '/approvers?name=*.Example.com&product=352')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { emails: ['admin@example.com'] },
    })
    expect(ssl.approvers).toHaveBeenCalledWith('*.example.com', '352')
  })

  it('refuses a missing or bad name or product, without asking the supplier', async () => {
    const ssl = client()
    for (const query of [
      '',
      '?name=example.com',
      '?name=not a name&product=351',
      '?name=example.com&product=3-5',
    ]) {
      expect((await call(app(ssl), `/approvers${query}`)).status).toBe(400)
    }
    expect(ssl.approvers).not.toHaveBeenCalled()
  })

  it('needs the gateway secret', async () => {
    const response = await app().request('/v1/ssl/approvers?name=example.com&product=351')
    expect(response.status).toBe(401)
  })

  it('refuses with writes off, when busy, and when the supplier cannot be asked', async () => {
    expect(
      (await call(app(client(), { target: null }), '/approvers?name=example.com&product=351'))
        .status,
    ).toBe(409)
    const empty = new TokenBucket(0, 0)
    expect(
      (await call(app(client(), { reads: empty }), '/approvers?name=example.com&product=351'))
        .status,
    ).toBe(429)
    const down = client({ approvers: { kind: 'unknown', code: 'TIMEOUT', message: 'slow' } })
    const response = await call(app(down), '/approvers?name=example.com&product=351')
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      code: 'SUPPLIER_UNAVAILABLE',
      retryable: true,
    })
  })
})

describe('POST /v1/ssl/csr/check', () => {
  it('says what a CSR asks for', async () => {
    const response = await call(app(), '/csr/check', {
      method: 'POST',
      body: JSON.stringify({ csr: CSR }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { commonName: 'shop.example.com' },
    })
  })

  it('refuses what is not a CSR, or carries a key, before the supplier sees it', async () => {
    const ssl = client()
    for (const csr of ['hello', `${CSR}\n${KEY}`, 42]) {
      const response = await call(app(ssl), '/csr/check', {
        method: 'POST',
        body: JSON.stringify({ csr }),
      })
      expect(response.status).toBe(422)
    }
    expect(ssl.checkCsr).not.toHaveBeenCalled()
  })

  it('passes on the CA’s refusal, and refuses when off, busy or down', async () => {
    const refused = client({
      checkCsr: { kind: 'unknown', code: 'CSR_INVALID', message: 'Invalid CSR code' },
    })
    expect(
      (
        await call(app(refused), '/csr/check', {
          method: 'POST',
          body: JSON.stringify({ csr: CSR }),
        })
      ).status,
    ).toBe(422)
    const body = { method: 'POST', body: JSON.stringify({ csr: CSR }) }
    expect((await call(app(client(), { target: null }), '/csr/check', body)).status).toBe(409)
    expect(
      (await call(app(client(), { reads: new TokenBucket(0, 0) }), '/csr/check', body)).status,
    ).toBe(429)
    const down = client({ checkCsr: { kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'x' } })
    expect((await call(app(down), '/csr/check', body)).status).toBe(502)
  })
})

describe('POST /v1/ssl/csr/generate', () => {
  it('returns the new key and request in the answer, and logs neither (N13)', async () => {
    const info = vi.spyOn(logger, 'info')
    const ssl = client()
    const response = await call(app(ssl), '/csr/generate', {
      method: 'POST',
      body: JSON.stringify(GENERATE),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { csr: CSR, privateKey: KEY },
    })
    expect(ssl.generateCsr).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'example.com', alternativeNames: ['www.example.com'] }),
    )
    expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(info.mock.calls)).not.toContain('CERTIFICATE REQUEST')
    info.mockRestore()
  })

  it('refuses incomplete details, and is metered harder than reads', async () => {
    const ssl = client()
    expect(
      (
        await call(app(ssl), '/csr/generate', {
          method: 'POST',
          body: JSON.stringify({ ...GENERATE, country: 'Nigeria' }),
        })
      ).status,
    ).toBe(400)
    expect((await call(app(ssl), '/csr/generate', { method: 'POST', body: '{' })).status).toBe(400)
    expect(
      (
        await call(app(ssl), '/csr/generate', {
          method: 'POST',
          body: JSON.stringify({ ...GENERATE, name: 'bad name' }),
        })
      ).status,
    ).toBe(400)
    expect(ssl.generateCsr).not.toHaveBeenCalled()
    const body = { method: 'POST', body: JSON.stringify(GENERATE) }
    expect((await call(app(ssl, { target: null }), '/csr/generate', body)).status).toBe(409)
    expect(
      (await call(app(ssl, { generates: new TokenBucket(0, 0) }), '/csr/generate', body)).status,
    ).toBe(429)
    const down = client({ generateCsr: { kind: 'unknown', code: 'TIMEOUT', message: 'slow' } })
    expect((await call(app(down), '/csr/generate', body)).status).toBe(502)
  })
})
