import { GatewayError } from '@dr/shared/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'
import { withinLimit } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/gateway', () => ({ callGateway: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  withinLimit: vi.fn(),
}))

const {
  checkCertificateRequest,
  generateCertificateRequest,
  loadApprovers,
  requestCertificateReissue,
  requestCertificateSetup,
} = await import('../actions/setup')

/**
 * FR-SSL-4, FR-SSL-8: the customer's side of a certificate. What matters:
 * nothing is sent for a certificate that is not theirs or not waiting for it,
 * the CA's own reading of the request is asked again, and a private key —
 * pasted, or generated for them — is never stored or logged (N13).
 */

const ID = '6f1c2a4e-0b7d-4c1e-9a55-2d8f0e3b7c10'
const CSR = `-----BEGIN CERTIFICATE REQUEST-----\n${'MIICozCCAYsCAQAwXjELMAkGA1UEBhMCTkcx\n'.repeat(5)}-----END CERTIFICATE REQUEST-----`
const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEtestONLY\n-----END RSA PRIVATE KEY-----'

const CERT = (over: Record<string, unknown> = {}) => ({
  id: ID,
  user_id: 'user-1',
  status: 'awaiting_setup',
  common_name: 'shop.example.com',
  product_code: '351',
  is_wildcard: false,
  included_names: 1,
  ...over,
})

const CONTACT = {
  firstName: 'Ada',
  lastName: 'Okafor',
  company: '',
  email: 'ada@example.com',
  phoneCountryCode: '234',
  phone: '0803 123 4567',
  addressLine1: '12 Admiralty Way',
  addressLine2: '',
  city: 'Lagos',
  state: 'Lagos',
  zipCode: '100001',
  country: 'NG',
}

let certificate: unknown
let rpc: ReturnType<typeof vi.fn>

function gateway(answers: Record<string, unknown>) {
  vi.mocked(callGateway).mockImplementation(async ({ path }) => {
    const key = Object.keys(answers).find((prefix) => path.startsWith(prefix))
    if (!key) throw new Error(`unexpected gateway path ${path}`)
    const answer = answers[key]
    if (answer instanceof Error) throw answer
    return answer as never
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  certificate = CERT()
  vi.mocked(withinLimit).mockResolvedValue(true)
  const read = {
    select: () => read,
    eq: () => read,
    maybeSingle: async () => ({ data: certificate }),
  }
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'ada@example.com' } } }) },
    from: () => read,
  } as never)
  rpc = vi.fn(async () => ({ data: 'job-1', error: null }))
  vi.mocked(createServiceClient).mockReturnValue({ rpc } as never)
  gateway({
    'ssl/approvers': { emails: ['admin@shop.example.com', 'admin@example.com'] },
    'ssl/csr/check': {
      commonName: 'shop.example.com',
      alternativeNames: [],
      isWildcard: false,
      organization: 'Example Ltd',
      country: 'NG',
    },
    'ssl/csr/generate': { csr: CSR, privateKey: KEY },
  })
})

const SETUP = {
  certificateId: ID,
  csr: CSR,
  approverEmail: 'Admin@Example.com',
  webServer: 'apache' as const,
  extraNames: [],
  contact: CONTACT,
}

describe('requestCertificateSetup', () => {
  it('checks the request with the CA, the approver against its list, and queues the set-up', async () => {
    const result = await requestCertificateSetup(SETUP)
    expect(result?.data).toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith('request_ssl_setup', {
      p_user_id: 'user-1',
      p_certificate_id: ID,
      p_csr: CSR,
      p_approver_email: 'admin@example.com',
      p_web_server: 'apache',
      p_san_names: [],
      p_contact: expect.objectContaining({
        city: 'Lagos',
        phone: '8031234567',
        phoneCountryCode: '234',
      }),
    })
  })

  it('refuses a pasted private key before anything is sent (N13)', async () => {
    const result = await requestCertificateSetup({ ...SETUP, csr: `${CSR}\n${KEY}` })
    expect(result?.data).toMatchObject({
      field: 'csr',
      error: expect.stringContaining('includes a private key'),
    })
    expect(callGateway).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a request for another name, an approver not on the list, and long contact fields', async () => {
    gateway({
      'ssl/approvers': { emails: ['admin@example.com'] },
      'ssl/csr/check': {
        commonName: 'other.com',
        alternativeNames: [],
        isWildcard: false,
        organization: null,
        country: null,
      },
    })
    expect((await requestCertificateSetup(SETUP))?.data).toMatchObject({
      field: 'csr',
      error: expect.stringContaining('other.com'),
    })

    gateway({
      'ssl/approvers': { emails: ['admin@example.com'] },
      'ssl/csr/check': {
        commonName: 'shop.example.com',
        alternativeNames: [],
        isWildcard: false,
        organization: null,
        country: null,
      },
    })
    expect(
      (await requestCertificateSetup({ ...SETUP, approverEmail: 'me@gmail.com' }))?.data,
    ).toMatchObject({
      field: 'approverEmail',
    })
    expect(
      (
        await requestCertificateSetup({
          ...SETUP,
          contact: { ...CONTACT, city: 'A city name longer than twenty' },
        })
      )?.data,
    ).toMatchObject({ field: 'contact.city', error: 'Use 20 characters or fewer' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('holds extra names to the product, and refuses them on a wildcard', async () => {
    expect(
      (await requestCertificateSetup({ ...SETUP, extraNames: ['www.example.com'] }))?.data,
    ).toMatchObject({
      field: 'extraNames',
      error: expect.stringContaining('covers 1 names in all'),
    })
    certificate = CERT({ is_wildcard: true, common_name: '*.example.com' })
    expect(
      (await requestCertificateSetup({ ...SETUP, extraNames: ['a.example.com'] }))?.data,
    ).toMatchObject({
      error: 'A wildcard certificate takes no extra names.',
    })
  })

  it('sends a multi-domain certificate’s other names, tidied', async () => {
    certificate = CERT({ common_name: 'example.com', product_code: '371', included_names: 4 })
    gateway({
      'ssl/approvers': { emails: ['admin@example.com'] },
      'ssl/csr/check': {
        commonName: 'example.com',
        alternativeNames: [],
        isWildcard: false,
        organization: null,
        country: null,
      },
    })
    await requestCertificateSetup({
      ...SETUP,
      approverEmail: 'admin@example.com',
      extraNames: [' WWW.example.com ', 'shop.example.com', 'www.example.com'],
    })
    expect(rpc).toHaveBeenCalledWith(
      'request_ssl_setup',
      expect.objectContaining({ p_san_names: ['www.example.com', 'shop.example.com'] }),
    )
  })

  it('refuses a certificate that is not yours, or not waiting for its set-up', async () => {
    certificate = null
    expect((await requestCertificateSetup(SETUP))?.data).toEqual({
      error: 'That certificate is not on your account.',
    })
    certificate = CERT({ status: 'issued' })
    expect((await requestCertificateSetup(SETUP))?.data).toMatchObject({
      error: expect.stringContaining('moved on'),
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('says so when the supplier cannot be asked, and when the database refuses', async () => {
    gateway({
      'ssl/approvers': new GatewayError('SUPPLIER_UNAVAILABLE', 'down', { retryable: true }),
      'ssl/csr/check': new GatewayError('SUPPLIER_UNAVAILABLE', 'down'),
    })
    expect((await requestCertificateSetup(SETUP))?.data).toMatchObject({
      error: expect.stringContaining('could not reach'),
    })
    gateway({
      'ssl/csr/check': new GatewayError('CSR_INVALID', 'bad'),
      'ssl/approvers': { emails: [] },
    })
    expect((await requestCertificateSetup(SETUP))?.data).toMatchObject({ field: 'csr' })

    gateway({
      'ssl/approvers': { emails: ['admin@example.com'] },
      'ssl/csr/check': {
        commonName: 'shop.example.com',
        alternativeNames: [],
        isWildcard: false,
        organization: null,
        country: null,
      },
    })
    rpc.mockResolvedValueOnce({ data: null, error: { code: '55000', message: 'moved' } })
    expect((await requestCertificateSetup(SETUP))?.data).toMatchObject({
      error: expect.stringContaining('moved on'),
    })
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not yours' } })
    expect((await requestCertificateSetup(SETUP))?.data).toEqual({
      error: 'That certificate is not on your account.',
    })
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'boom' } })
    expect((await requestCertificateSetup(SETUP))?.data).toMatchObject({
      error: expect.stringContaining('Nothing was sent'),
    })
  })
})

describe('the set-up’s helpers', () => {
  it('lists the approval addresses the CA offers', async () => {
    expect((await loadApprovers({ certificateId: ID }))?.data).toEqual({
      emails: ['admin@shop.example.com', 'admin@example.com'],
    })
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'ssl/approvers?name=shop.example.com&product=351' }),
    )
    gateway({ 'ssl/approvers': { emails: [] } })
    expect((await loadApprovers({ certificateId: ID }))?.data).toMatchObject({
      error: expect.stringContaining('no approval address'),
    })
    gateway({ 'ssl/approvers': new Error('down') })
    expect((await loadApprovers({ certificateId: ID }))?.data).toMatchObject({
      error: expect.stringContaining('could not reach'),
    })
    gateway({ 'ssl/approvers': { nonsense: true } })
    expect((await loadApprovers({ certificateId: ID }))?.data).toMatchObject({
      error: expect.any(String),
    })
  })

  it('checks a CSR against the certificate’s name', async () => {
    expect((await checkCertificateRequest({ certificateId: ID, csr: CSR }))?.data).toMatchObject({
      summary: { commonName: 'shop.example.com' },
    })
    expect(
      (await checkCertificateRequest({ certificateId: ID, csr: 'nonsense' }))?.data,
    ).toMatchObject({ field: 'csr' })
    vi.mocked(withinLimit).mockResolvedValueOnce(false)
    expect((await checkCertificateRequest({ certificateId: ID, csr: CSR }))?.data).toMatchObject({
      error: expect.stringContaining('Too many'),
    })
    gateway({
      'ssl/csr/check': {
        commonName: 'www.example.com',
        alternativeNames: [],
        isWildcard: false,
        organization: null,
        country: null,
      },
    })
    expect((await checkCertificateRequest({ certificateId: ID, csr: CSR }))?.data).toMatchObject({
      error: expect.stringContaining('www.example.com'),
    })
    gateway({ 'ssl/csr/check': new GatewayError('CSR_INVALID', 'bad') })
    expect((await checkCertificateRequest({ certificateId: ID, csr: CSR }))?.data).toMatchObject({
      field: 'csr',
    })
    gateway({ 'ssl/csr/check': new GatewayError('SUPPLIER_UNAVAILABLE', 'down') })
    expect((await checkCertificateRequest({ certificateId: ID, csr: CSR }))?.data).toMatchObject({
      error: expect.stringContaining('could not reach'),
    })
  })

  it('hands a generated key to the browser and logs only that one was made (N13)', async () => {
    const info = vi.spyOn(logger, 'info')
    const result = await generateCertificateRequest({
      certificateId: ID,
      organization: 'Example Ltd',
      locality: 'Ikeja',
      state: 'Lagos',
      country: 'ng',
      extraNames: [],
    })
    expect(result?.data).toEqual({ csr: CSR, privateKey: KEY })
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'ssl/csr/generate',
        body: expect.objectContaining({
          name: 'shop.example.com',
          country: 'NG',
          organizationUnit: 'IT',
        }),
      }),
    )
    expect(JSON.stringify(info.mock.calls)).not.toContain('PRIVATE KEY')
    // Nothing is stored: the database is never called.
    expect(rpc).not.toHaveBeenCalled()
    info.mockRestore()
  })

  it('refuses to generate for bad names, too often, or when the supplier is down', async () => {
    const base = {
      certificateId: ID,
      organization: 'Example',
      locality: 'Ikeja',
      state: 'Lagos',
      country: 'NG',
    }
    expect(
      (await generateCertificateRequest({ ...base, extraNames: ['a.example.com'] }))?.data,
    ).toMatchObject({ field: 'extraNames' })
    vi.mocked(withinLimit).mockResolvedValueOnce(false)
    expect((await generateCertificateRequest({ ...base, extraNames: [] }))?.data).toMatchObject({
      error: expect.stringContaining('Too many'),
    })
    gateway({ 'ssl/csr/generate': new Error('down') })
    expect((await generateCertificateRequest({ ...base, extraNames: [] }))?.data).toMatchObject({
      error: expect.stringContaining('could not reach'),
    })
  })
})

describe('requestCertificateReissue', () => {
  it('queues a reissue of an issued certificate, and only of one', async () => {
    certificate = CERT({ status: 'issued' })
    expect((await requestCertificateReissue({ certificateId: ID }))?.data).toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith('request_ssl_reissue', {
      p_user_id: 'user-1',
      p_certificate_id: ID,
    })
    rpc.mockResolvedValueOnce({ data: null, error: { code: '55000', message: 'moved' } })
    expect((await requestCertificateReissue({ certificateId: ID }))?.data).toMatchObject({
      error: expect.stringContaining('moved on'),
    })
    certificate = CERT({ status: 'awaiting_validation' })
    expect((await requestCertificateReissue({ certificateId: ID }))?.data).toMatchObject({
      error: expect.stringContaining('moved on'),
    })
  })
})
