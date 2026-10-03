import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CertificateView, isSettling } from '@/features/admin/components/ssl/certificate-view'
import { SslListView } from '@/features/admin/components/ssl/ssl-list-view'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import {
  type CertificateDetail,
  getCertificate,
  getSslStats,
  listCertificates,
  listPaidWithoutCertificate,
} from '@/features/admin/queries/ssl'
import { ids } from './fake-db'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/admin/ssl',
}))
vi.mock('@/features/admin/components/shell/side-switch', () => ({
  SideSwitch: ({ side }: { side: string }) => <p>Side: {side}</p>,
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({ lookupSsl: vi.fn() }))
vi.mock('@/features/admin/queries/session', () => ({
  requireAdmin: vi.fn(),
  getAdminSide: vi.fn(),
}))
vi.mock('@/features/admin/queries/ssl', () => ({
  CALLS_SHOWN: 50,
  listCertificates: vi.fn(),
  getSslStats: vi.fn(),
  listPaidWithoutCertificate: vi.fn(),
  getCertificate: vi.fn(),
}))

const admin = { role: 'operator', testOnly: true, label: 'e2e' }
const stats = {
  byStatus: { issued: 1 },
  total: 1,
  unrecognised: 0,
  jobsNeedingPerson: 0,
  jobsOpen: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue(admin as never)
  vi.mocked(getAdminSide).mockResolvedValue('test')
})

function detail(overrides: Partial<CertificateDetail> = {}): CertificateDetail {
  return {
    certificate: {
      id: ids.certificate,
      userId: ids.user,
      commonName: 'shop.example.com',
      productCode: '351',
      productName: 'Sectigo PositiveSSL Certificate',
      isWildcard: false,
      testMode: true,
      status: 'issued',
      supplierStatus: 'Active',
      unrecognisedSince: null,
      purchasedAt: '2026-10-01T10:00:00Z',
      subscriptionEndsAt: '2027-10-01T10:00:00Z',
      expiresAt: '2027-04-20T10:00:00Z',
      lastCheckedAt: null,
      lastErrorCode: null,
      reissueCount: 0,
      createdAt: '2026-10-01T09:59:00Z',
      orderItemId: ids.line,
      includedNames: 1,
      sanNames: [],
      supplierCertificateId: null,
      validationMethod: 'email',
      approverMasked: 'a•••@shop.example.com',
      webServer: 'iis',
      configuredAt: null,
      issuedAt: null,
      certificatePem: null,
      caBundlePem: null,
      nextCheckAt: null,
      updatedAt: null,
    },
    line: { ok: true, data: null },
    jobs: { ok: true, data: [] },
    refunds: { ok: true, data: [] },
    calls: { ok: true, data: [] },
    ...overrides,
  }
}

describe('SslListView', () => {
  it('reads the list from the URL on the admin’s side, with the figures and paid lines', async () => {
    vi.mocked(listCertificates).mockResolvedValue({ rows: [], total: 0 })
    vi.mocked(getSslStats).mockResolvedValue(stats)
    vi.mocked(listPaidWithoutCertificate).mockResolvedValue([])
    render(
      await SslListView({
        searchParams: Promise.resolve({ status: 'failed', unrecognised: '1' }),
      }),
    )
    expect(listCertificates).toHaveBeenCalledWith(
      admin,
      'test',
      expect.objectContaining({ status: ['failed'], unrecognised: true }),
    )
    expect(getSslStats).toHaveBeenCalledWith('test')
    expect(listPaidWithoutCertificate).toHaveBeenCalledWith(admin, 'test', expect.any(Date))
    expect(screen.getByRole('heading', { level: 1, name: 'Certificates' })).toBeInTheDocument()
    expect(screen.getByText('Side: test')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'At a glance' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '0 certificates' })).toBeInTheDocument()
    expect(screen.getByText('No certificates match these filters.')).toBeInTheDocument()
    expect(
      screen.getByText('Every paid certificate line on this side has its certificate.'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Admin',
      }),
    ).toHaveAttribute('href', '/admin')
  })

  it('shows an error state for each read that failed, never an empty list', async () => {
    vi.mocked(listCertificates).mockRejectedValue(new Error('down'))
    vi.mocked(getSslStats).mockRejectedValue(new Error('down'))
    vi.mocked(listPaidWithoutCertificate).mockRejectedValue(new Error('down'))
    render(await SslListView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText('The certificates couldn’t be loaded.')).toBeInTheDocument()
    expect(screen.getByText('The certificate figures couldn’t be read.')).toBeInTheDocument()
    expect(screen.getByText('The paid certificate lines couldn’t be read.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Certificates' })).toBeInTheDocument()
  })

  it('never sends an email, or anything that is not a name, to the list', async () => {
    vi.mocked(getSslStats).mockResolvedValue(stats)
    vi.mocked(listPaidWithoutCertificate).mockResolvedValue([])
    render(await SslListView({ searchParams: Promise.resolve({ q: 'someone@example.com' }) }))
    expect(listCertificates).not.toHaveBeenCalled()
    expect(screen.getByText(/certificates are never looked up by email/)).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search certificates' })).toHaveValue('')

    render(await SslListView({ searchParams: Promise.resolve({ q: 'ND-001040' }) }))
    expect(listCertificates).not.toHaveBeenCalled()
  })

  it('counts a list of one in the singular', async () => {
    vi.mocked(listCertificates).mockResolvedValue({
      rows: [
        {
          ...detail().certificate,
        },
      ],
      total: 1,
    })
    vi.mocked(getSslStats).mockResolvedValue(stats)
    vi.mocked(listPaidWithoutCertificate).mockResolvedValue([])
    render(await SslListView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('heading', { level: 2, name: '1 certificate' })).toBeInTheDocument()
  })
})

describe('CertificateView', () => {
  it('shows one certificate with its name, state and test badge', async () => {
    vi.mocked(getCertificate).mockResolvedValue(detail())
    render(
      await CertificateView({ params: Promise.resolve({ id: ids.certificate.toUpperCase() }) }),
    )
    expect(getCertificate).toHaveBeenCalledWith(admin, 'test', ids.certificate)
    expect(screen.getByRole('heading', { level: 1, name: 'shop.example.com' })).toBeInTheDocument()
    expect(screen.getByText('Test')).toBeInTheDocument()
    expect(
      screen.getByText(
        /Sectigo PositiveSSL Certificate · ordered 1 Oct 2026, 10:59 WAT\. Read only/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Set-up' })).toHaveTextContent('Microsoft IIS')
    expect(screen.getByRole('button', { name: 'Check status now' })).toBeInTheDocument()
  })

  it('says a certificate is not on this side, without reading for an id that is not one', async () => {
    vi.mocked(getCertificate).mockResolvedValue(null)
    render(await CertificateView({ params: Promise.resolve({ id: ids.certificate }) }))
    expect(screen.getByText('No certificate with this id on the Test side.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to certificates' })).toHaveAttribute(
      'href',
      '/admin/ssl',
    )

    render(await CertificateView({ params: Promise.resolve({ id: 'shop.example.com' }) }))
    expect(getCertificate).toHaveBeenCalledTimes(1)
  })

  it('shows an error state when the certificate cannot be read', async () => {
    vi.mocked(getCertificate).mockRejectedValue(new Error('down'))
    render(await CertificateView({ params: Promise.resolve({ id: ids.certificate }) }))
    expect(screen.getByRole('alert')).toHaveTextContent('This certificate couldn’t be loaded.')
    expect(screen.getByRole('heading', { level: 1, name: 'Certificate' })).toBeInTheDocument()
  })

  it('re-reads our records only while something is moving', () => {
    expect(isSettling(detail())).toBe(false)
    expect(
      isSettling(detail({ certificate: { ...detail().certificate, status: 'setting_up' } })),
    ).toBe(true)
    const job = {
      id: ids.job,
      kind: 'ssl_reissue',
      status: 'queued',
      attempts: 0,
      lastErrorCode: null,
      sentAt: null,
      runAfter: '2026-10-03T10:00:00Z',
      createdAt: '2026-10-03T10:00:00Z',
      finishedAt: null,
    }
    expect(isSettling(detail({ jobs: { ok: true, data: [job] } }))).toBe(true)
    expect(isSettling(detail({ jobs: { ok: true, data: [{ ...job, status: 'failed' }] } }))).toBe(
      false,
    )
    expect(isSettling(detail({ jobs: { ok: false } }))).toBe(false)
  })
})
