import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupSsl } from '@/features/admin/actions/supplier-live'
import {
  CertificateBody,
  LiveStatusSection,
  SetupSection,
  StandingSection,
  TermSection,
} from '@/features/admin/components/ssl/certificate-sections'
import { CheckStatus } from '@/features/admin/components/ssl/check-status'
import {
  SslFilterForm,
  SslSearch,
  SslStatusChips,
} from '@/features/admin/components/ssl/ssl-filters'
import {
  CertificateListBody,
  PaidWithoutCertificate,
} from '@/features/admin/components/ssl/ssl-list-view'
import { CertificateSkeleton, SslListSkeleton } from '@/features/admin/components/ssl/ssl-skeleton'
import { SslStatsPanel, sslTiles } from '@/features/admin/components/ssl/ssl-stats'
import { ADMIN_ERROR_WORDS, LOST_ANSWER_WORDS } from '@/features/admin/lib/errors'
import { parseSslListParams } from '@/features/admin/lib/ssl-params'
import type {
  CertificateDetail,
  CertificateRecord,
  CertificateRow,
} from '@/features/admin/queries/ssl'
import { ids, NOW } from './fake-db'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/admin/ssl',
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({ lookupSsl: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const operator = { role: 'operator' as const, testOnly: true }
const viewer = { role: 'viewer' as const, testOnly: false }

function row(overrides: Partial<CertificateRow> = {}): CertificateRow {
  return {
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
    lastCheckedAt: '2026-10-03T09:00:00Z',
    lastErrorCode: null,
    reissueCount: 0,
    createdAt: '2026-10-01T09:59:00Z',
    ...overrides,
  }
}

function record(overrides: Partial<CertificateRecord> = {}): CertificateRecord {
  return {
    ...row(),
    orderItemId: ids.line,
    includedNames: 1,
    sanNames: [],
    supplierCertificateId: null,
    validationMethod: 'email',
    approverMasked: 'a•••@shop.example.com',
    webServer: 'apache',
    configuredAt: '2026-10-01T11:00:00Z',
    issuedAt: '2026-10-02T10:00:00Z',
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    caBundlePem: '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----',
    nextCheckAt: '2026-10-03T21:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z',
    ...overrides,
  }
}

function detail(overrides: Partial<CertificateDetail> = {}): CertificateDetail {
  return {
    certificate: record(),
    line: {
      ok: true,
      data: {
        id: ids.line,
        orderId: ids.order,
        orderNumber: 'ND-001040',
        name: 'shop.example.com',
        priceKobo: 1_350_000,
        renewalKobo: 1_400_000,
        status: 'completed',
        failureCode: null,
      },
    },
    jobs: {
      ok: true,
      data: [
        {
          id: ids.job,
          kind: 'ssl_initialize',
          status: 'succeeded',
          attempts: 1,
          lastErrorCode: null,
          sentAt: '2026-10-01T10:00:00Z',
          runAfter: '2026-10-01T10:00:00Z',
          createdAt: '2026-10-01T09:59:00Z',
          finishedAt: '2026-10-01T10:00:05Z',
        },
      ],
    },
    refunds: { ok: true, data: [] },
    calls: {
      ok: true,
      data: [
        {
          id: 7,
          createdAt: '2026-10-03T11:05:00Z',
          operation: 'AdminSslCheckStatus',
          outcome: 'ok',
          errorCode: null,
          httpStatus: 200,
          durationMs: 420,
          sslJobId: null,
        },
        {
          id: 6,
          createdAt: '2026-10-01T10:00:00Z',
          operation: 'SslInitialize',
          outcome: 'ok',
          errorCode: null,
          httpStatus: 200,
          durationMs: 1800,
          sslJobId: ids.job,
        },
      ],
    },
    ...overrides,
  }
}

describe('CertificateListBody', () => {
  const list = {
    rows: [row(), row({ id: ids.job, commonName: '*.example.com', testMode: false })],
    total: 2,
  }

  it('lists certificates linked by id, never by name, with their state in words', () => {
    render(
      <CertificateListBody side="test" params={parseSslListParams({})} list={list} now={NOW} />,
    )
    const table = screen.getByRole('table', { name: /Certificates on the Test side, page 1 of 1/ })
    const cell = within(table).getByRole('link', { name: 'shop.example.com' })
    expect(cell).toHaveAttribute('href', `/admin/ssl/${ids.certificate}`)
    expect(within(table).getByRole('link', { name: '*.example.com' })).toHaveAttribute(
      'href',
      `/admin/ssl/${ids.job}`,
    )
    expect(within(table).getAllByText('Issued').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('Active').length).toBeGreaterThan(0)
    expect(within(table).getAllByText('20 Apr 2027 (in 198 days)').length).toBeGreaterThan(0)
    expect(within(table).getAllByRole('link', { name: 'Account 2a2b2c2d' })[0]).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}`,
    )
    // Sortable headers say how they sort.
    expect(within(table).getByRole('columnheader', { name: /Ordered/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(screen.getByRole('navigation', { name: 'Sort certificates' })).toBeInTheDocument()
    expect(screen.getByText('2 in all')).toBeInTheDocument()
  })

  it('refuses an email search in words, keeping no email in any link (N13)', () => {
    const params = parseSslListParams({ q: 'someone@example.com', status: 'issued' })
    render(<CertificateListBody side="test" params={params} list={null} now={NOW} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nothing was searched: certificates are never looked up by email',
    )
    expect(screen.getByRole('link', { name: 'Go to Customers' })).toHaveAttribute(
      'href',
      '/admin/customers',
    )
    expect(
      screen.getByRole('link', { name: 'Show certificates without a search' }),
    ).toHaveAttribute('href', '/admin/ssl?status=issued')
  })

  it('says what a search that is not a name could not do', () => {
    const params = parseSslListParams({ q: 'ND-001040' })
    render(<CertificateListBody side="test" params={params} list={null} now={NOW} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nothing was searched: that isn’t a certificate’s name',
    )
    expect(screen.queryByRole('link', { name: 'Go to Customers' })).not.toBeInTheDocument()
  })

  it('has an error state with a way on, never an empty list', () => {
    render(
      <CertificateListBody side="test" params={parseSslListParams({})} list={null} now={NOW} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The certificates couldn’t be loaded.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('tells an empty side from an empty filter, and a page past the end', () => {
    const { unmount } = render(
      <CertificateListBody
        side="test"
        params={parseSslListParams({})}
        list={{ rows: [], total: 0 }}
        now={NOW}
      />,
    )
    expect(screen.getByText('No certificates on the Test side yet.')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Test certificates appear here once someone buys one with Flutterwave’s test keys.',
      ),
    ).toBeInTheDocument()
    unmount()

    const { unmount: second } = render(
      <CertificateListBody
        side="live"
        params={parseSslListParams({ status: 'failed' })}
        list={{ rows: [], total: 0 }}
        now={NOW}
      />,
    )
    expect(screen.getByText('No certificates match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute(
      'href',
      '/admin/ssl',
    )
    second()

    render(
      <CertificateListBody
        side="live"
        params={parseSslListParams({ page: '9' })}
        list={{ rows: [], total: 30 }}
        now={NOW}
      />,
    )
    expect(screen.getByText('Nothing on page 9.')).toBeInTheDocument()
    expect(screen.getByText('The list has 2 pages.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/ssl',
    )
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
  })

  it('shows a product by its code when it has no name, and no customer link without one', () => {
    render(
      <CertificateListBody
        side="live"
        params={parseSslListParams({})}
        list={{
          rows: [row({ productName: null, userId: null, lastCheckedAt: null, expiresAt: null })],
          total: 1,
        }}
        now={NOW}
      />,
    )
    const table = screen.getByRole('table')
    expect(within(table).getByText('351')).toBeInTheDocument()
    expect(within(table).getByText('Not yet')).toBeInTheDocument()
    expect(within(table).getByText('Not issued yet')).toBeInTheDocument()
    expect(within(table).queryByRole('link', { name: /^Account/ })).not.toBeInTheDocument()
  })
})

describe('PaidWithoutCertificate', () => {
  it('lists paid lines with no certificate, linked to their order', () => {
    render(
      <PaidWithoutCertificate
        lines={[
          {
            id: ids.line,
            orderId: ids.order,
            orderNumber: 'ND-001040',
            name: 'lost.example.com',
            productCode: '351',
            paidAt: '2026-10-03T10:00:00Z',
          },
          {
            id: ids.job,
            orderId: ids.order,
            orderNumber: null,
            name: 'other.example.com',
            productCode: null,
            paidAt: null,
          },
        ]}
      />,
    )
    const region = screen.getByRole('region', { name: 'Paid, no certificate' })
    expect(within(region).getAllByRole('link', { name: 'ND-001040' })[0]).toHaveAttribute(
      'href',
      `/admin/orders/${ids.order}`,
    )
    expect(within(region).getAllByRole('link', { name: 'Open the order' }).length).toBeGreaterThan(
      0,
    )
    expect(region).toHaveTextContent('Nothing on this page creates a certificate.')
  })

  it('says when every paid line has its certificate, and when it could not tell', () => {
    const { unmount } = render(<PaidWithoutCertificate lines={[]} />)
    expect(
      screen.getByText('Every paid certificate line on this side has its certificate.'),
    ).toBeInTheDocument()
    unmount()
    render(<PaidWithoutCertificate lines={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The paid certificate lines couldn’t be read.',
    )
  })
})

describe('SslStatsPanel', () => {
  const stats = {
    byStatus: { issued: 3, pending: 1, setting_up: 1, reissuing: 1, failed: 2, revoked: 1 },
    total: 9,
    unrecognised: 1,
    jobsNeedingPerson: 2,
    jobsOpen: 1,
  }

  it('links each figure to the list it counts, the count inside the link’s name', () => {
    render(<SslStatsPanel stats={stats} />)
    const region = screen.getByRole('region', { name: 'At a glance' })
    expect(region).toHaveTextContent('9 certificates · 1 job open')
    expect(within(region).getByRole('link', { name: /^Issued 3/ })).toHaveAttribute(
      'href',
      '/admin/ssl?status=issued',
    )
    expect(within(region).getByRole('link', { name: /^In progress 3/ })).toHaveAttribute(
      'href',
      '/admin/ssl?status=pending%2Csetting_up%2Creissuing',
    )
    expect(within(region).getByRole('link', { name: /^Unknown supplier word 1/ })).toHaveAttribute(
      'href',
      '/admin/ssl?unrecognised=1',
    )
    expect(
      within(region).getByRole('link', { name: /^Certificate jobs needing a person 2/ }),
    ).toHaveAttribute('href', '/admin/queue/ssl-jobs?status=needs_attention')
  })

  it('tints only what needs a person', () => {
    const quiet = sslTiles({
      byStatus: {},
      total: 0,
      unrecognised: 0,
      jobsNeedingPerson: 0,
      jobsOpen: 0,
    })
    expect(quiet.map((tile) => tile.tone)).toEqual([
      'ok',
      'info',
      'info',
      'info',
      'neutral',
      'neutral',
      'neutral',
      'neutral',
    ])
    const busy = sslTiles(stats)
    expect(busy.find((tile) => tile.label === 'Not ordered')?.tone).toBe('danger')
    expect(busy.find((tile) => tile.label === 'Unknown supplier word')?.tone).toBe('warning')
    render(<SslStatsPanel stats={{ ...stats, total: 1, jobsOpen: 2 }} />)
    expect(screen.getByText('1 certificate · 2 jobs open')).toBeInTheDocument()
  })
})

describe('the filters', () => {
  const params = parseSslListParams({
    status: 'issued',
    unrecognised: '1',
    sort: 'expires',
    dir: 'asc',
    per: '50',
    line: ids.line,
    q: 'shop.example.com',
    from: '2026-10-01',
  })

  it('search by name only: the box refuses an email before it is sent', () => {
    render(<SslSearch params={params} />)
    const box = screen.getByRole('searchbox', { name: 'Search certificates' })
    expect(box).toHaveAttribute('pattern', '[^@]*')
    expect(box).toHaveValue('shop.example.com')
    const form = screen.getByRole('form', { name: 'Search certificates' })
    const hidden = Object.fromEntries(
      [...(form?.querySelectorAll('input[type=hidden]') ?? [])].map((input) => [
        input.getAttribute('name'),
        input.getAttribute('value'),
      ]),
    )
    expect(hidden).toEqual({
      status: 'issued',
      sort: 'expires',
      dir: 'asc',
      per: '50',
      line: ids.line,
      from: '2026-10-01',
      unrecognised: '1',
    })
  })

  it('chips toggle a status and count it, the chosen one marked in words', () => {
    render(<SslStatusChips params={params} counts={{ issued: 3 }} />)
    const nav = screen.getByRole('navigation', { name: 'Certificate status' })
    const issued = within(nav).getByRole('link', { name: 'Issued (3)' })
    expect(issued).toHaveAttribute('aria-current', 'true')
    expect(within(nav).getByRole('link', { name: 'Not ordered (0)' })).toHaveAttribute(
      'href',
      `/admin/ssl?status=issued%2Cfailed&from=2026-10-01&sort=expires&dir=asc&per=50&unrecognised=1&line=${ids.line}&q=shop.example.com`,
    )
  })

  it('chips work without the figures', () => {
    render(<SslStatusChips params={parseSslListParams({})} counts={null} />)
    expect(screen.getByRole('link', { name: 'Waiting for approval' })).toHaveAttribute(
      'href',
      '/admin/ssl?status=awaiting_validation',
    )
  })

  it('the filter form keeps the search and says what the box is for', () => {
    render(<SslFilterForm params={params} />)
    expect(screen.getByLabelText('Ordered from')).toHaveValue('2026-10-01')
    expect(screen.getByLabelText('Unknown supplier word only')).toBeChecked()
    expect(screen.getByRole('link', { name: 'Clear all' })).toHaveAttribute('href', '/admin/ssl')
    const form = screen.getByRole('form', { name: 'Filter certificates' })
    expect(form.querySelector('input[name=q]')).toHaveAttribute('value', 'shop.example.com')
  })
})

describe('the certificate page', () => {
  it('shows where it stands, the approver masked, and the term only in SSL_TERM’s words', () => {
    const { container } = render(
      <CertificateBody detail={detail()} viewer={operator} now={NOW} callsShown={50} />,
    )
    const standing = screen.getByRole('region', { name: 'Where it stands' })
    expect(standing).toHaveTextContent(
      'Issued. The customer downloads it from their certificate page.',
    )
    expect(standing).toHaveTextContent('DomainNameAPI says')

    const setup = screen.getByRole('region', { name: 'Set-up' })
    expect(setup).toHaveTextContent('a•••@shop.example.com')
    expect(setup).toHaveTextContent('Approval email')
    expect(setup).toHaveTextContent('Apache')
    expect(setup).toHaveTextContent('The private key is never stored or shown here')

    const term = screen.getByRole('region', { name: 'Term' })
    expect(term).toHaveTextContent('1-year subscription, bought 1 Oct 2026')
    expect(term).toHaveTextContent('20 Apr 2027 (in 198 days)')
    expect(term).toHaveTextContent('₦13,500')
    // N8: the price shows what comes after it.
    expect(term).toHaveTextContent(
      'It never renews by itself: when the subscription ends, buy a new certificate — ₦14,000 at today’s price.',
    )
    expect(term).toHaveTextContent('Certificates now last at most 200 days')
    expect(container.textContent).not.toMatch(/valid for (a|one|1) year/i)

    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByRole('link', { name: 'ND-001040' })).toHaveAttribute(
      'href',
      `/admin/orders/${ids.order}`,
    )
    expect(within(summary).getByRole('link', { name: 'Account 2a2b2c2d' })).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}`,
    )
    expect(summary).toHaveTextContent('Sectigo PositiveSSL Certificate (351)')
    expect(summary).toHaveTextContent('Not given')

    const text = screen.getByRole('region', { name: 'Certificate text' })
    expect(within(text).getByText('Certificate (PEM)')).toBeInTheDocument()
    expect(within(text).getByText('Chain (CA bundle)')).toBeInTheDocument()

    const jobs = screen.getByRole('region', { name: 'Jobs' })
    expect(within(jobs).getAllByRole('link', { name: 'Certificate order' })[0]).toHaveAttribute(
      'href',
      `/admin/queue/ssl-jobs/${ids.job}`,
    )
    expect(screen.getByRole('region', { name: 'Refunds' })).toHaveTextContent(
      'No refunds for this certificate’s line.',
    )
    const calls = screen.getByRole('region', { name: 'Supplier calls' })
    expect(within(calls).getAllByText('AdminSslCheckStatus').length).toBeGreaterThan(0)
    expect(within(calls).getAllByRole('link', { name: 'Job 6a6b6c6d' })[0]).toHaveAttribute(
      'href',
      `/admin/queue/ssl-jobs/${ids.job}`,
    )
    expect(calls).toHaveTextContent('up to 50')

    const live = screen.getByRole('region', { name: 'Read from DomainNameAPI' })
    expect(live).toHaveTextContent('Last read by an admin: 3 Oct 2026, 12:05 WAT (found).')
    expect(within(live).getByRole('button', { name: 'Check status now' })).toBeInTheDocument()
    expect(lookupSsl).not.toHaveBeenCalled()
  })

  it('never shows a supplier word it does not know, and says what that means', () => {
    render(
      <StandingSection
        certificate={record({
          status: 'awaiting_validation',
          supplierStatus: 'SomethingNew',
          unrecognisedSince: '2026-10-02T09:00:00Z',
          lastErrorCode: 'CSR_NAME_MISMATCH',
        })}
        now={NOW}
      />,
    )
    const standing = screen.getByRole('region', { name: 'Where it stands' })
    expect(standing).not.toHaveTextContent('SomethingNew')
    expect(standing).toHaveTextContent('Not a word we know (since 2 Oct 2026, 10:00 WAT)')
    expect(standing).toHaveTextContent('after a day this raises an alert that names the word')
    expect(standing).toHaveTextContent('CSR_NAME_MISMATCH')
    expect(standing).toHaveTextContent(
      'The customer is told: The certificate request (CSR) is for a different name.',
    )
  })

  it('a viewer reads the page but is not offered the live read', () => {
    render(
      <LiveStatusSection
        certificate={record()}
        calls={{ ok: true, data: [] }}
        viewer={viewer}
        returnTo="/admin/ssl"
      />,
    )
    expect(screen.queryByRole('button', { name: 'Check status now' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Your admin role can’t read DomainNameAPI. Ask an operator.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('No admin has read its status from DomainNameAPI yet.'),
    ).toBeInTheDocument()
  })

  it('gives each part that failed its own error state', () => {
    render(
      <CertificateBody
        detail={detail({
          line: { ok: false },
          jobs: { ok: false },
          refunds: { ok: false },
          calls: { ok: false },
        })}
        viewer={operator}
        now={NOW}
        callsShown={50}
      />,
    )
    expect(screen.getAllByRole('alert')).toHaveLength(3)
    expect(screen.getAllByText('This part of the certificate couldn’t be loaded.').length).toBe(5)
    expect(screen.queryByText(/Last read by an admin/)).not.toBeInTheDocument()
  })

  it('a certificate not yet set up or issued says so, with no text and no price', () => {
    render(
      <>
        <SetupSection
          certificate={record({
            validationMethod: null,
            approverMasked: null,
            webServer: null,
            configuredAt: null,
            sanNames: ['www.shop.example.com'],
          })}
        />
        <TermSection
          certificate={record({
            purchasedAt: null,
            subscriptionEndsAt: null,
            expiresAt: null,
            issuedAt: null,
          })}
          line={{ ok: true, data: null }}
          now={NOW}
        />
      </>,
    )
    const setup = screen.getByRole('region', { name: 'Set-up' })
    expect(setup).toHaveTextContent('The customer hasn’t sent the set-up yet.')
    expect(within(setup).getAllByText('Not sent yet')).toHaveLength(3)
    expect(setup).toHaveTextContent('www.shop.example.com')
    const term = screen.getByRole('region', { name: 'Term' })
    expect(term).toHaveTextContent('Set when it is bought')
    expect(term).toHaveTextContent('Not issued yet')
    expect(term).not.toHaveTextContent('₦')
  })

  it('a certificate without its text, chain, line or product name still reads', () => {
    render(
      <CertificateBody
        detail={detail({
          certificate: record({
            certificatePem: null,
            productName: null,
            supplierCertificateId: '5e5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3',
            lastErrorCode: 'SOMETHING_ELSE',
          }),
          line: { ok: true, data: null },
          calls: { ok: true, data: [] },
          refunds: {
            ok: true,
            data: [
              {
                id: ids.refund,
                status: 'queued',
                amountKobo: 1_350_000,
                reason: 'ssl_failed',
                createdAt: '2026-10-02T09:00:00Z',
              },
            ],
          },
        })}
        viewer={operator}
        now={NOW}
        callsShown={50}
      />,
    )
    expect(screen.getByRole('region', { name: 'Certificate text' })).toHaveTextContent(
      'No certificate text yet: it is stored once the certificate authority issues the certificate.',
    )
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(summary).toHaveTextContent('Its order line couldn’t be found on this side.')
    expect(summary).toHaveTextContent('351')
    expect(
      within(summary).getByRole('button', { name: 'Copy DomainNameAPI’s id' }),
    ).toBeInTheDocument()
    const refunds = screen.getByRole('region', { name: 'Refunds' })
    expect(within(refunds).getAllByRole('link', { name: 'Refund 7a7b7c7d' })[0]).toHaveAttribute(
      'href',
      `/admin/refunds/${ids.refund}`,
    )
    expect(refunds).toHaveTextContent('Certificate not ordered')
    expect(screen.getByRole('region', { name: 'Supplier calls' })).toHaveTextContent(
      'No supplier calls are recorded for this certificate.',
    )
    expect(screen.getByRole('region', { name: 'Where it stands' })).toHaveTextContent(
      'The customer is told: The certificate authority’s supplier did not accept it.',
    )
  })

  it('shows a chain-less certificate and a failed line with its code', () => {
    render(
      <CertificateBody
        detail={detail({
          certificate: record({ caBundlePem: null, status: 'failed' }),
          line: {
            ok: true,
            data: {
              id: ids.line,
              orderId: ids.order,
              orderNumber: null,
              name: 'shop.example.com',
              priceKobo: 1,
              renewalKobo: 1,
              status: 'failed',
              failureCode: 'FAILED_BY_ADMIN',
            },
          },
        })}
        viewer={operator}
        now={NOW}
        callsShown={50}
      />,
    )
    expect(screen.getByText('No chain was stored with it.')).toBeInTheDocument()
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(summary).toHaveTextContent('FAILED_BY_ADMIN')
    expect(within(summary).getByRole('link', { name: /^Order 4d1e2f3a/ })).toBeInTheDocument()
  })
})

describe('the loading states', () => {
  it('pulse in the page’s shape, hidden from screen readers (S11)', () => {
    const { container, unmount } = render(<SslListSkeleton />)
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(3)
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
    expect(container.textContent).toBe('')
    unmount()
    const detail = render(<CertificateSkeleton />)
    expect(detail.container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(3)
    expect(detail.container.textContent).toBe('')
  })
})

describe('CheckStatus', () => {
  const readAt = '2026-10-03T11:05:00.000Z'

  it('reads on a click — never on render — says what it found, and re-reads the page', async () => {
    vi.mocked(lookupSsl).mockResolvedValue({
      data: {
        ok: true,
        auditId: 1,
        data: {
          name: '*.example.com',
          outcome: 'not_found',
          status: null,
          isConfigured: null,
          isIssued: null,
          certificateExpiresAt: null,
          subscriptionEndsAt: null,
          validUntil: null,
          readAt,
        },
      },
    } as never)
    const user = userEvent.setup()
    render(<CheckStatus name="*.example.com" returnTo="/admin/ssl" />)
    expect(lookupSsl).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Check status now' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Read at 12:05 WAT: DomainNameAPI has no certificate under this name',
      ),
    )
    expect(lookupSsl).toHaveBeenCalledWith({ name: '*.example.com' })
    expect(refresh).toHaveBeenCalled()
  })

  it('says a refusal in words, and changes nothing', async () => {
    vi.mocked(lookupSsl).mockResolvedValue({
      data: { ok: false, code: 'TOO_SOON', message: ADMIN_ERROR_WORDS.TOO_SOON },
    } as never)
    const user = userEvent.setup()
    render(<CheckStatus name="shop.example.com" returnTo="/admin/ssl" />)
    await user.click(screen.getByRole('button', { name: 'Check status now' }))
    await waitFor(() =>
      expect(screen.getByText(ADMIN_ERROR_WORDS.TOO_SOON as string)).toBeInTheDocument(),
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  it('says when the answer was lost, empty, or never came', async () => {
    const user = userEvent.setup()
    vi.mocked(lookupSsl).mockResolvedValueOnce({ serverError: 'x' } as never)
    const { unmount } = render(<CheckStatus name="shop.example.com" returnTo="/admin/ssl" />)
    await user.click(screen.getByRole('button', { name: 'Check status now' }))
    await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument())
    unmount()

    vi.mocked(lookupSsl).mockResolvedValueOnce({ data: { ok: true, auditId: 2 } } as never)
    const second = render(<CheckStatus name="shop.example.com" returnTo="/admin/ssl" />)
    await user.click(screen.getByRole('button', { name: 'Check status now' }))
    await waitFor(() =>
      expect(
        screen.getByText(
          'DomainNameAPI answered nothing we could read. Nothing was changed; try again.',
        ),
      ).toBeInTheDocument(),
    )
    second.unmount()

    vi.mocked(lookupSsl).mockRejectedValueOnce(new Error('network'))
    const third = render(<CheckStatus name="shop.example.com" returnTo="/admin/ssl" />)
    await user.click(screen.getByRole('button', { name: 'Check status now' }))
    await waitFor(() =>
      expect(
        screen.getByText("The read didn't come back. Nothing was changed; try again."),
      ).toBeInTheDocument(),
    )
    third.unmount()

    vi.mocked(lookupSsl).mockResolvedValueOnce(undefined as never)
    render(<CheckStatus name="shop.example.com" returnTo="/admin/ssl" />)
    await user.click(screen.getByRole('button', { name: 'Check status now' }))
    await waitFor(() => expect(screen.getByText(LOST_ANSWER_WORDS)).toBeInTheDocument())
  })

  it('cannot be pressed twice while a read is on its way (S12)', async () => {
    let finish: (value: unknown) => void = () => {}
    vi.mocked(lookupSsl).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }) as never,
    )
    const user = userEvent.setup()
    render(<CheckStatus name="shop.example.com" returnTo="/admin/ssl" />)
    const button = screen.getByRole('button', { name: 'Check status now' })
    await user.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    await user.click(button)
    expect(lookupSsl).toHaveBeenCalledTimes(1)
    finish({ data: { ok: false, code: 'X', message: 'Refused.' } })
    await waitFor(() => expect(button).not.toBeDisabled())
  })
})
