import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NoAnswer } from '../lib/http'
import { Semaphore } from '../lib/semaphore'
import type { CallRecord } from '../provisioning/registrar'
import {
  createSslSupplier,
  GENERATED_KEY,
  OTE,
  SAMPLE_PEM,
  viaFetch,
} from '../test-support/ssl-supplier'
import { createSslClient, judgeSsl, SSL_BASE_URL, sslDate, sslErrorCode } from './client'

/**
 * The SSL client against MSW handlers shaped like the supplier's sandbox
 * (Appendix E) — real HTTP requests, answered by MSW, never the supplier (N12).
 */

const supplier = createSslSupplier()
const server = setupServer(...supplier.handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  supplier.certificates.clear()
  supplier.calls.length = 0
})
afterAll(() => server.close())

function client(audit: (call: CallRecord) => Promise<void> = async () => {}) {
  return createSslClient({
    environment: 'ote',
    apiKey: 'test-key',
    resellerId: 'reseller',
    audit,
    slots: new Semaphore(2),
    timeoutMs: 5_000,
    request: viaFetch,
  })
}

const CSR = '-----BEGIN CERTIFICATE REQUEST-----\nMIICozCCAYsC\n-----END CERTIFICATE REQUEST-----'
const CONTACT = {
  firstName: 'Ada',
  lastName: 'Okafor',
  companyName: 'Ada Okafor',
  eMail: 'ada@example.com',
  address: '12 Admiralty Way',
  phoneCountryCode: 'NG',
  phone: '+2348031234567',
  faxCountryCode: 'NG',
  fax: '+2348031234567',
  country: 'NG',
  city: 'Lagos',
  state: 'Lagos',
  postalCode: '100001',
}

describe('the SSL client against the supplier’s shapes', () => {
  it('talks to the sandbox for test orders and production for live ones', () => {
    expect(SSL_BASE_URL.ote).toBe(OTE)
    expect(SSL_BASE_URL.production).toBe('https://api.domainresellerapi.com/api/v1')
  })

  it('buys, reads back, sets up and reissues a certificate, by its name', async () => {
    const ssl = client()
    await expect(ssl.status('example.com')).resolves.toEqual({ kind: 'not_found' })

    const bought = await ssl.initialize('351', 'example.com')
    expect(bought).toEqual({
      kind: 'ok',
      data: { certificateId: '55abd0f6-639d-a3b5-8d62-3a240e9bfcb0', status: 'WaitingForInstall' },
    })
    const details = await ssl.details('example.com')
    expect(details).toMatchObject({
      kind: 'found',
      data: {
        status: 'WaitingForInstall',
        packageCode: '351',
        // Zoneless SSL dates are UTC (Appendix E).
        purchasedAt: '2026-10-02T11:45:37.456Z',
        subscriptionEndsAt: '2027-10-02T11:45:37.456Z',
        issuedAt: null,
      },
    })

    const configured = await ssl.configure({
      name: 'example.com',
      csr: CSR,
      approverEmail: 'admin@example.com',
      webServer: 'apache',
      extraNames: ['www.example.com', 'shop.example.com'],
      contact: CONTACT,
    })
    expect(configured).toEqual({ kind: 'ok', data: { status: 'WaitingForValidation' } })
    const sent = supplier.calls.find((call) => call.path === '/ssls/configure')?.body as Record<
      string,
      unknown
    >
    expect(sent).toMatchObject({
      domainName: 'example.com',
      authenticationType: 'EMAIL',
      webServerType: 'apache',
      sanList: 'www.example.com,shop.example.com',
    })
    // Never a private key: the supplier does not need one.
    expect(sent).not.toHaveProperty('privateKey')

    await expect(ssl.status('example.com')).resolves.toMatchObject({
      kind: 'found',
      data: {
        status: 'WaitingForValidation',
        isConfigured: true,
        isIssued: false,
        certificateExpiresAt: null,
      },
    })
    await expect(ssl.reissue('example.com', 'admin@example.com')).resolves.toEqual({
      kind: 'ok',
      data: { status: 'WaitingForValidation' },
    })
  })

  it('reads an issued certificate and its chain, keeping nothing but certificates', async () => {
    supplier.certificates.set('example.com', {
      packageCode: '351',
      status: 'Active',
      configured: true,
      purchasedAt: '2026-10-02T11:45:37',
      certificate: `${SAMPLE_PEM.replace(/\n/g, '\r\n')}\r\n`,
    })
    const ssl = client()
    await expect(ssl.status('example.com')).resolves.toMatchObject({
      kind: 'found',
      data: { status: 'Active', isIssued: true, certificateExpiresAt: '2027-04-20T11:54:19.267Z' },
    })
    const content = await ssl.content('example.com')
    expect(content).toEqual({
      kind: 'found',
      data: {
        certificate: SAMPLE_PEM,
        intermediates: [
          '-----BEGIN CERTIFICATE-----\nMIIFakeIntermediate\n-----END CERTIFICATE-----',
        ],
        root: '',
      },
    })
  })

  it('reads a wildcard by its *. name, which the details call refuses', async () => {
    const ssl = client()
    await ssl.initialize('352', '*.example.com')
    await expect(ssl.status('*.example.com')).resolves.toMatchObject({ kind: 'found' })
    await expect(ssl.details('*.example.com')).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NAME_INVALID',
    })
  })

  it('lists approvers, deduplicated and lower-cased', async () => {
    server.use(
      http.get(`${OTE}/ssls/approvers`, () =>
        HttpResponse.json({ mails: ['Admin@Example.com', 'admin@example.com', 'not-an-address'] }),
      ),
    )
    await expect(client().approvers('example.com', '351')).resolves.toEqual({
      kind: 'found',
      data: ['admin@example.com'],
    })
  })

  it('reads what a CSR asks for, and refuses one that is not', async () => {
    const ssl = client()
    await expect(ssl.checkCsr(CSR)).resolves.toEqual({
      kind: 'found',
      data: {
        commonName: 'shop.example.com',
        alternativeNames: [],
        isWildcard: false,
        organization: 'Example Ltd',
        country: 'NG',
      },
    })
    await expect(ssl.checkCsr('nonsense')).resolves.toMatchObject({
      kind: 'unknown',
      code: 'CSR_INVALID',
    })
  })

  it('hands back a generated key and records only that it happened (N13)', async () => {
    const audit = vi.fn(async (_call: CallRecord) => {})
    const made = await client(audit).generateCsr({
      name: 'example.com',
      alternativeNames: ['www.example.com'],
      country: 'NG',
      state: 'Lagos',
      locality: 'Ikeja',
      organization: 'Example Ltd',
      organizationUnit: 'IT',
    })
    expect(made).toEqual({
      kind: 'found',
      data: {
        csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIICsjCCAZoC\n-----END CERTIFICATE REQUEST-----',
        privateKey: GENERATED_KEY,
      },
    })
    expect(supplier.calls.at(-1)?.body).toMatchObject({ alternativeNames: ['www.example.com'] })
    expect(JSON.stringify(audit.mock.calls)).not.toContain('PRIVATE KEY')
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ operation: 'SslGenerateCsr', outcome: 'ok' })
  })

  it('records every call for its job, without bodies', async () => {
    const audit = vi.fn(async (_call: CallRecord) => {})
    await client(audit).initialize('351', 'example.com')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'SslInitialize',
        domainName: 'example.com',
        outcome: 'ok',
        httpStatus: 200,
        errorCode: null,
        message: null,
      }),
    )
  })

  it('reports a refused product, a refused set-up and a missing certificate in our words', async () => {
    const ssl = client()
    await expect(ssl.initialize('999999', 'example.com')).resolves.toMatchObject({
      kind: 'rejected',
      code: 'SSL_PRODUCT_UNKNOWN',
    })
    await expect(
      ssl.configure({
        name: 'missing.com',
        csr: CSR,
        approverEmail: 'a@b.co',
        webServer: 'iis',
        extraNames: [],
        contact: CONTACT,
      }),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'CERTIFICATE_NOT_FOUND' })
    await ssl.initialize('351', 'example.com')
    await ssl.configure({
      name: 'example.com',
      csr: CSR,
      approverEmail: 'a@b.co',
      webServer: 'iis',
      extraNames: [],
      contact: CONTACT,
    })
    await expect(
      ssl.configure({
        name: 'example.com',
        csr: CSR,
        approverEmail: 'a@b.co',
        webServer: 'iis',
        extraNames: [],
        contact: CONTACT,
      }),
    ).resolves.toMatchObject({ kind: 'rejected', code: 'SSL_WRONG_STATE' })
  })

  it('treats a set-up the supplier errored on as unknown, never as refused', async () => {
    const ssl = client()
    await ssl.initialize('351', 'example.com')
    const answer = await ssl.configure({
      name: 'example.com',
      csr: CSR,
      approverEmail: 'admin@example.com',
      webServer: 'apache',
      extraNames: [],
      contact: { ...CONTACT, fax: '' },
    })
    expect(answer).toMatchObject({ kind: 'unknown', code: 'HTTP_500' })
  })

  it('treats no answer as unknown, and a slot it could not get the same way', async () => {
    const timeout = vi.fn(async () => {
      throw new NoAnswer('timeout')
    })
    const ssl = createSslClient({
      environment: 'ote',
      apiKey: 'k',
      resellerId: 'r',
      audit: async () => {},
      request: timeout as never,
    })
    await expect(ssl.initialize('351', 'example.com')).resolves.toEqual({
      kind: 'unknown',
      code: 'TIMEOUT',
      message: 'No answer from the supplier (TIMEOUT)',
    })
    const full = new Semaphore(0)
    const waiting = createSslClient({
      environment: 'ote',
      apiKey: 'k',
      resellerId: 'r',
      audit: async () => {},
      slots: full,
      slotWait: { waitMs: 1, priority: 'low' },
    })
    await expect(waiting.status('example.com')).resolves.toMatchObject({
      kind: 'unknown',
      code: 'NETWORK',
    })
  })

  it('cannot read an answer it does not understand', async () => {
    server.use(http.put(`${OTE}/ssls/check-status`, () => HttpResponse.json({ nothing: true })))
    await expect(client().status('example.com')).resolves.toMatchObject({
      kind: 'unknown',
      code: 'UNPARSEABLE',
    })
  })
})

describe('judging an SSL answer', () => {
  const answer = (status: number, body: unknown) => ({ status, body })
  const error = (code: string | null, message: string) => ({ error: { code, message } })

  it.each([
    [answer(200, { success: true }), 'ok'],
    [answer(200, { success: false, message: 'No' }), 'rejected:SSL_REFUSED'],
    [answer(403, error('Ssl:10026', 'Certificate not found')), 'not_found'],
    [
      answer(403, error('Ssl:10048', 'An internal error occurred')),
      'unknown:SUPPLIER_INTERNAL_ERROR',
    ],
    [
      answer(403, error('', 'An internal error occurred during your request!')),
      'unknown:SUPPLIER_INTERNAL_ERROR',
    ],
    [answer(403, error('Ssl:10040', 'mismatch')), 'rejected:CSR_NAME_MISMATCH'],
    [answer(403, error('Ssl:10019', 'not wildcard')), 'rejected:CSR_NOT_WILDCARD'],
    [answer(403, error('Ssl:10014', 'Invalid email address')), 'rejected:APPROVER_INVALID'],
    [answer(403, error('Ssl:10003', 'Package is not supported')), 'rejected:NOT_SUPPORTED'],
    [answer(403, error('Ssl:99999', 'Something new')), 'rejected:SSL_REFUSED'],
    [answer(403, error('API_301', 'IP not allowed')), 'blocked:SUPPLIER_IP_BLOCKED'],
    [answer(403, null), 'blocked:SUPPLIER_IP_BLOCKED'],
    [answer(402, error(null, 'Insufficient balance')), 'rejected:SUPPLIER_INSUFFICIENT_FUNDS'],
    [answer(400, error('API_350', 'Balance')), 'rejected:SUPPLIER_INSUFFICIENT_FUNDS'],
    [answer(401, null), 'blocked:SUPPLIER_AUTH'],
    [answer(429, null), 'unknown:HTTP_429'],
    [answer(502, null), 'unknown:HTTP_502'],
    [
      answer(400, {
        error: {
          message: 'Your request is not valid!',
          validationErrors: [{ message: 'PhoneCountryCode' }],
        },
      }),
      'rejected:SSL_INVALID_REQUEST',
    ],
    [answer(404, error(null, 'There is no entity Package')), 'rejected:SSL_PRODUCT_UNKNOWN'],
    [answer(409, error(null, 'Conflict')), 'rejected:SSL_REFUSED'],
  ])('%j → %s', (input, expected) => {
    const verdict = judgeSsl(input)
    expect('code' in verdict ? `${verdict.outcome}:${verdict.code}` : verdict.outcome).toBe(
      expected,
    )
  })

  it('never keeps a key the supplier echoes back (N13)', () => {
    const verdict = judgeSsl({
      status: 400,
      body: error(null, 'Bad key -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- here'),
    })
    expect('message' in verdict && verdict.message).toBe('Bad key [PEM removed] here')
  })

  it('reads the code wherever the supplier put it', () => {
    expect(sslErrorCode({ error: { code: ' Ssl:10026 ' } })).toBe('Ssl:10026')
    expect(sslErrorCode({ error: { code: null, message: 'API_301 not allowed' } })).toBe('API_301')
    expect(sslErrorCode({ error: 'x' })).toBeNull()
    expect(sslErrorCode(null)).toBeNull()
  })

  it('reads zoneless SSL dates as UTC, and zoned ones as given', () => {
    expect(sslDate('2026-10-02T11:45:37.4562692')).toBe('2026-10-02T11:45:37.456Z')
    expect(sslDate('2026-10-02T14:54:38.2680753+03:00')).toBe('2026-10-02T11:54:38.268Z')
    expect(sslDate('')).toBeNull()
    expect(sslDate('soon')).toBeNull()
    expect(sslDate(null)).toBeNull()
  })
})
