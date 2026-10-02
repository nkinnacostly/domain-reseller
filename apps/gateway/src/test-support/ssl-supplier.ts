import { HttpResponse, http } from 'msw'
import { type JsonResponse, NoAnswer, type requestJson } from '../lib/http'

/**
 * MSW handlers for every SSL endpoint of the supplier (PRD Appendix E), in
 * the sandbox's own answers as read on 2 Oct 2026 — so a test talks HTTP to
 * something shaped like the supplier, never to the supplier (N12).
 *
 * State lives in `certificates`, keyed by the name the supplier knows: like
 * the sandbox, a name answers with its first certificate only.
 */

export const OTE = 'https://ote.domainresellerapi.com/api/v1'

export type FakeCertificate = {
  packageCode: string
  status: 'WaitingForInstall' | 'WaitingForValidation' | 'Active' | string
  configured: boolean
  purchasedAt: string
  certificate: string
}

const notFound = () =>
  HttpResponse.json(
    {
      error: {
        code: 'Ssl:10026',
        message: 'Certificate not found',
        details: null,
        data: {},
        validationErrors: null,
      },
    },
    { status: 403 },
  )

const refusal = (code: string, message: string) =>
  HttpResponse.json(
    { error: { code, message, details: null, data: {}, validationErrors: null } },
    { status: 403 },
  )

export const SAMPLE_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIFakeCertificateForTests\n-----END CERTIFICATE-----'
export const SAMPLE_CHAIN =
  '-----BEGIN CERTIFICATE-----\nMIIFakeIntermediate\n-----END CERTIFICATE-----'
export const GENERATED_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEtestKEYnotreal\n-----END RSA PRIVATE KEY-----'

/**
 * requestJson's contract over fetch, which MSW intercepts in every runtime.
 * requestJson keeps node:https's own `request`, captured at import, which a
 * test interceptor cannot reach — so without this a test would go out to
 * the real sandbox. Unhandled requests fail the test instead.
 */
export const viaFetch: typeof requestJson = async (url, init = {}) => {
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch (error) {
    throw new NoAnswer(error instanceof Error ? error.message : String(error))
  }
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: response.status, body } satisfies JsonResponse
}

export function createSslSupplier() {
  const certificates = new Map<string, FakeCertificate>()
  const calls: { method: string; path: string; body: unknown }[] = []

  async function note(request: Request) {
    const url = new URL(request.url)
    const body =
      request.method === 'GET'
        ? null
        : await request
            .clone()
            .json()
            .catch(() => null)
    calls.push({ method: request.method, path: url.pathname.replace('/api/v1', ''), body })
    return body as Record<string, unknown> | null
  }

  const handlers = [
    http.get(`${OTE}/products/ssls`, async ({ request }) => {
      await note(request)
      return HttpResponse.json({
        totalCount: 2,
        items: [
          {
            name: 'Sectigo PositiveSSL Certificate',
            productCode: '351',
            vendorName: 'Sectigo',
            validationType: 'DV',
            isWildcard: false,
            isMultiDomain: false,
            defaultSanCount: 1,
            maxSanCount: 1,
            warrantyAmount: 0,
            issueTimeMinutes: 0,
            isReissueFree: true,
            requiresCsr: true,
            prices: [
              { priceGroup: 'Reseller', create: [{ period: 1, price: 6.99, currency: 'USD' }] },
            ],
          },
          {
            name: 'Sectigo PositiveSSL Wildcard',
            productCode: '352',
            vendorName: 'Sectigo',
            validationType: 'DV',
            isWildcard: true,
            isMultiDomain: false,
            defaultSanCount: 1,
            maxSanCount: 100,
            isReissueFree: true,
            requiresCsr: true,
            prices: [
              { priceGroup: 'Reseller', create: [{ period: 1, price: 87.99, currency: 'USD' }] },
            ],
          },
        ],
      })
    }),

    http.put(`${OTE}/ssls/check-status`, async ({ request }) => {
      const body = await note(request)
      const name = String(body?.domainName ?? '')
      const found = certificates.get(name)
      if (!found) return notFound()
      return HttpResponse.json({
        domainName: name,
        status: found.status,
        statusMessage: found.status,
        isConfigured: found.configured,
        isIssued: found.status === 'Active',
        certificateExpiresAt:
          found.status === 'Active' ? '2027-04-20T14:54:19.2678379+03:00' : null,
      })
    }),

    http.get(`${OTE}/ssls/certificate`, async ({ request }) => {
      await note(request)
      const name = new URL(request.url).searchParams.get('DomainName') ?? ''
      // The supplier refuses a `*.` name here (sandbox, 2 Oct 2026).
      if (name.startsWith('*.'))
        return refusal('Dna.DomainService:Domain:10044', 'Domain name is not valid')
      const found = certificates.get(name)
      if (!found) return notFound()
      return HttpResponse.json({
        domainName: name,
        status: found.status,
        isConfigured: found.configured,
        isIssued: found.status === 'Active',
        packageName: 'Sectigo PositiveSSL Certificate',
        packageCode: found.packageCode,
        subscription: { purchasedAt: found.purchasedAt, expiresAt: '2027-10-02T11:45:37.4562692' },
        configuration: null,
        certificate:
          found.status === 'Active'
            ? { issuedAt: '2026-10-02T14:54:38+03:00', validUntil: '2027-04-20T14:54:38+03:00' }
            : null,
        contacts: [],
      })
    }),

    http.get(`${OTE}/ssls/certificate-content`, async ({ request }) => {
      await note(request)
      const found = certificates.get(new URL(request.url).searchParams.get('DomainName') ?? '')
      if (!found) return notFound()
      if (found.status !== 'Active') {
        return refusal('Ssl:10048', 'An internal error occurred during your request!')
      }
      return HttpResponse.json({
        certificate: found.certificate,
        intermediateCertificate1: found.certificate ? SAMPLE_CHAIN : '',
        intermediateCertificate2: '',
        rootCertificate: '',
      })
    }),

    http.get(`${OTE}/ssls/approvers`, async ({ request }) => {
      await note(request)
      const name = (new URL(request.url).searchParams.get('DomainName') ?? '').replace(/^\*\./, '')
      return HttpResponse.json({
        mails: ['admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster'].map(
          (box) => `${box}@${name}`,
        ),
      })
    }),

    http.post(`${OTE}/ssls/check-csr`, async ({ request }) => {
      const body = await note(request)
      if (!String(body?.csr ?? '').includes('MIIC')) return refusal('Ssl:10004', 'Invalid CSR code')
      return HttpResponse.json({
        domainName: 'shop.example.com',
        country: 'NG',
        state: 'Lagos',
        locality: 'Ikeja',
        organization: 'Example Ltd',
        organizationUnit: null,
        alternativeNames: '',
        isWildcard: false,
        isSan: false,
      })
    }),

    http.post(`${OTE}/ssls/generate-csr`, async ({ request }) => {
      await note(request)
      return HttpResponse.json({
        csr: '-----BEGIN CERTIFICATE REQUEST-----\r\nMIICsjCCAZoC\r\n-----END CERTIFICATE REQUEST-----\r\n',
        privateKey: `${GENERATED_KEY.replace(/\n/g, '\r\n')}\r\n`,
      })
    }),

    http.post(`${OTE}/ssls/initialize`, async ({ request }) => {
      const body = await note(request)
      const code = String(body?.packageCode ?? '')
      if (code === '999999') {
        return HttpResponse.json(
          { error: { code: null, message: 'There is no entity Package with id = 999999!' } },
          { status: 404 },
        )
      }
      const name = String(body?.domainName ?? '')
      if (!certificates.has(name)) {
        certificates.set(name, {
          packageCode: code,
          status: 'WaitingForInstall',
          configured: false,
          purchasedAt: '2026-10-02T11:45:37.4562692',
          certificate: '',
        })
      }
      return HttpResponse.json({
        success: true,
        message: 'SSL certificate purchase initialized successfully. Waiting for installation.',
        certificateId: '55abd0f6-639d-a3b5-8d62-3a240e9bfcb0',
        status: 'WaitingForInstall',
      })
    }),

    http.put(`${OTE}/ssls/configure`, async ({ request }) => {
      const body = await note(request)
      const found = certificates.get(String(body?.domainName ?? ''))
      if (!found) return notFound()
      if (found.status !== 'WaitingForInstall') {
        return refusal(
          'Ssl:10027',
          'The current status of the certificate does not allow this operation',
        )
      }
      // The sandbox answered 500 to a set-up without a fax number.
      const contact = (body?.contact ?? {}) as Record<string, unknown>
      if (!contact.fax) {
        return HttpResponse.json(
          { error: { code: null, message: 'An internal error occurred during your request!' } },
          { status: 500 },
        )
      }
      found.status = 'WaitingForValidation'
      found.configured = true
      return HttpResponse.json({
        success: true,
        message: 'SSL certificate configured successfully. Pending domain validation.',
        certificateId: '55abd0f6-639d-a3b5-8d62-3a240e9bfcb0',
        status: 'WaitingForValidation',
      })
    }),

    http.post(`${OTE}/ssls/reissue`, async ({ request }) => {
      const body = await note(request)
      const found = certificates.get(String(body?.domainName ?? ''))
      if (!found) return notFound()
      found.status = 'WaitingForValidation'
      return HttpResponse.json({
        success: true,
        message: 'Reissued',
        status: 'WaitingForValidation',
      })
    }),
  ]

  return { handlers, certificates, calls }
}
