import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queueDeepSync, revealRegistrant } from '@/features/admin/actions/domains'
import { lookupDomain, readRegistrantVerification } from '@/features/admin/actions/supplier-live'
import { DeepSyncButton } from '@/features/admin/components/domains/deep-sync'
import {
  byExtension,
  byStatus,
  DomainStatsPanel,
  statsTlds,
} from '@/features/admin/components/domains/domain-stats'
import { DomainDetailBody, DomainNotFound } from '@/features/admin/components/domains/domain-view'
import {
  DomainSortLinks,
  DomainStatusChips,
  DomainsFilterForm,
  DomainsSearch,
} from '@/features/admin/components/domains/domains-filters'
import { DomainsList } from '@/features/admin/components/domains/domains-view'
import { RegistrantPanel } from '@/features/admin/components/domains/registrant'
import {
  RegistryCompare,
  VerificationRead,
} from '@/features/admin/components/domains/registry-reads'
import { DEEP_SYNC, REGISTRY, REVEAL } from '@/features/admin/lib/domains-copy'
import { parseDomainListParams } from '@/features/admin/lib/domains-params'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import type {
  DomainDetail,
  DomainListRow,
  DomainRecord,
  DomainStats,
} from '@/features/admin/queries/domains'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/components/shell/side-switch', () => ({
  SideSwitch: ({ side }: { side: string }) => <p>Side: {side}</p>,
}))
vi.mock('@/features/admin/actions/domains', () => ({
  queueDeepSync: vi.fn(),
  revealRegistrant: vi.fn(),
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({
  lookupDomain: vi.fn(),
  readRegistrantVerification: vi.fn(),
}))

beforeEach(() => vi.clearAllMocks())

const DOMAIN = '5a5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3'
const USER = '2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d'
const ORDER = '0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6'
const JOB = '6a6b6c6d-7e7f-4a8b-8c9d-aeafb0b1c2c3'
const NOW = new Date('2026-10-03T12:00:00Z')
const readAt = '2026-10-03T11:05:00.000Z'

const operator = { role: 'operator' as const, testOnly: false }
const testAdmin = { role: 'operator' as const, testOnly: true }
const viewer = { role: 'viewer' as const, testOnly: false }

function listRow(overrides: Partial<DomainListRow> = {}): DomainListRow {
  return {
    id: DOMAIN,
    name: 'getpaid.com',
    tld: 'com',
    source: 'registration',
    testMode: true,
    userId: USER,
    status: 'active',
    expiresAt: '2027-03-01T10:00:00Z',
    autoRenew: true,
    transferLock: true,
    pendingTransferLock: false,
    privacy: false,
    pendingPrivacy: null,
    delegation: 'verified',
    registryStatus: 'Active',
    registryCheckedAt: '2026-10-03T10:00:00Z',
    createdAt: '2026-09-01T10:00:00Z',
    ...overrides,
  }
}

function record(overrides: Partial<DomainRecord> = {}): DomainRecord {
  return {
    ...listRow(),
    orderItemId: '3a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d',
    registeredAt: '2026-03-01T10:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z',
    nameservers: ['ns1.example-dns.net', 'ns2.example-dns.net'],
    pendingNameservers: null,
    previousNameservers: null,
    presetId: null,
    delegationCheckedAt: '2026-10-03T11:30:00Z',
    registryRenewalMode: 'AutoRenew',
    deepCheckedAt: null,
    registrantCountry: 'NG',
    registrantType: 'individual',
    ...overrides,
  }
}

function detail(
  domain: Partial<DomainRecord> = {},
  rest: Partial<Omit<DomainDetail, 'domain'>> = {},
): DomainDetail {
  return {
    domain: record(domain),
    line: {
      ok: true,
      data: {
        id: '3a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d',
        orderId: ORDER,
        orderNumber: 'ND-001035',
        itemType: 'register',
      },
    },
    preset: { ok: true, data: null },
    jobs: {
      ok: true,
      data: {
        total: 1,
        rows: [
          {
            id: JOB,
            kind: 'register_domain',
            status: 'succeeded',
            lastErrorCode: null,
            attempts: 1,
            createdAt: '2026-09-01T10:00:00Z',
            updatedAt: '2026-09-01T10:05:00Z',
          },
        ],
      },
    },
    history: { ok: true, data: [] },
    drift: { ok: true, data: [] },
    events: {
      ok: true,
      data: [
        { id: 5, eventType: 'registered', actorType: 'system', createdAt: '2026-09-01T10:05:00Z' },
      ],
    },
    gateway: { kind: 'read', beatAt: '2026-10-03T11:58:00Z' },
    ...rest,
  }
}

const stats: DomainStats = {
  byTldStatus: [
    { tld: 'com', status: 'active', count: 5 },
    { tld: 'com', status: 'pending', count: 1 },
    { tld: 'ng', status: 'redemption', count: 2 },
    { tld: 'ng', status: 'mystery', count: 1 },
  ],
  expiries: {
    expired: 2,
    d30: 1,
    d60: 3,
    d90: 4,
    autoOn90: 3,
    autoOff90: 1,
    next: '2026-10-20T10:00:00Z',
  },
  delegation: [
    { status: 'verified', count: 4 },
    { status: 'failed', count: 2 },
  ],
  registryAutoRenewLabel: [
    { mode: 'AutoRenew', count: 5 },
    { mode: 'unknown', count: 2 },
  ],
}

describe('the figures', () => {
  it('rolls the counts up by extension and by status', () => {
    expect(byExtension(stats.byTldStatus)).toEqual([
      { tld: 'com', live: 5, other: 1 },
      { tld: 'ng', live: 2, other: 1 },
    ])
    expect(byStatus(stats.byTldStatus)).toEqual([
      { status: 'pending', count: 1 },
      { status: 'active', count: 5 },
      { status: 'redemption', count: 2 },
      { status: 'mystery', count: 1 },
    ])
    expect(statsTlds(stats)).toEqual(['com', 'ng'])
    expect(statsTlds(null)).toEqual([])
  })

  it('links each tile to the list with the statuses it was counted over', () => {
    render(<DomainStatsPanel stats={stats} />)
    const panel = screen.getByRole('region', { name: 'At a glance' })
    expect(
      within(panel).getByRole('link', { name: /Active, expired or in redemption 7/ }),
    ).toHaveAttribute('href', '/admin/domains?status=active%2Cexpired_grace%2Credemption')
    expect(within(panel).getByRole('link', { name: /Past their expiry 2/ })).toHaveAttribute(
      'href',
      '/admin/domains?status=active%2Cexpired_grace%2Credemption&expires=expired',
    )
    expect(within(panel).getByRole('link', { name: /Expiring within 30 days 1/ })).toHaveAttribute(
      'href',
      '/admin/domains?status=active%2Cexpired_grace%2Credemption&expires=30',
    )
    expect(
      within(panel).getByRole('link', { name: /Nameservers not working in DNS 2/ }),
    ).toHaveAttribute(
      'href',
      '/admin/domains?status=active%2Cexpired_grace%2Credemption&delegation=failed',
    )
    expect(within(panel).getByText('20 Oct 2026')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Registering 1' })).toHaveAttribute(
      'href',
      '/admin/domains?status=pending',
    )
    // An unknown status is shown in words of its own, linking to the whole list.
    expect(within(panel).getByRole('link', { name: 'mystery 1' })).toHaveAttribute(
      'href',
      '/admin/domains',
    )
    expect(
      within(panel).getByText(
        "Registry renewal mode 'AutoRenew' (the supplier's label; automatic renewal isn't available to our account, BACKLOG L18)",
      ),
    ).toBeInTheDocument()
    expect(within(panel).getByText('Registry renewal mode not read yet')).toBeInTheDocument()
    expect(within(panel).getAllByRole('link', { name: '.ng' })[0]).toHaveAttribute(
      'href',
      '/admin/domains?tld=ng',
    )
  })

  it('says so when the side holds nothing', () => {
    render(
      <DomainStatsPanel
        stats={{
          byTldStatus: [],
          expiries: { expired: 0, d30: 0, d60: 0, d90: 0, autoOn90: 0, autoOff90: 0, next: null },
          delegation: [],
          registryAutoRenewLabel: [],
        }}
      />,
    )
    expect(screen.getAllByText('No domains on this side yet.')).toHaveLength(2)
    expect(screen.getByText('Nothing expires from now on')).toBeInTheDocument()
    expect(
      screen.getByText('No active domain has been read from the registry yet.'),
    ).toBeInTheDocument()
  })
})

describe('the filters', () => {
  it('keeps the other filters in each form, and never takes an email', () => {
    const params = parseDomainListParams({
      status: 'active',
      tld: 'ng',
      expires: '30',
      sort: 'name',
      q: 'getpaid',
    })
    const { container } = render(
      <>
        <DomainsSearch params={params} />
        <DomainStatusChips params={params} />
        <DomainsFilterForm params={params} tlds={['com']} />
        <DomainSortLinks params={params} />
      </>,
    )
    const search = screen.getByRole('searchbox', { name: 'Search domains' })
    expect(search).toHaveValue('getpaid')
    expect(search).toHaveAttribute('pattern', '[^@]*')
    const searchForm = screen.getByRole('form', { name: 'Search domains' }) as HTMLFormElement
    expect(new FormData(searchForm).get('expires')).toBe('30')
    expect(new FormData(searchForm).get('sort')).toBe('name')
    // The URL's extension is a choice even when the figures did not list it.
    expect(screen.getByRole('combobox', { name: 'Extension' })).toHaveValue('ng')
    expect(screen.getByRole('option', { name: '.com' })).toBeInTheDocument()
    const filterForm = screen.getByRole('form', { name: 'Filter domains' }) as HTMLFormElement
    expect(new FormData(filterForm).get('q')).toBe('getpaid')
    const chips = screen.getByRole('navigation', { name: 'Domain status' })
    expect(within(chips).getByRole('link', { name: 'Active' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(chips).getByRole('link', { name: 'Redemption' })).toHaveAttribute(
      'href',
      '/admin/domains?status=active%2Credemption&sort=name&tld=ng&expires=30&q=getpaid',
    )
    const sorts = screen.getByRole('navigation', { name: 'Sort domains' })
    expect(within(sorts).getByRole('link', { name: /^Name/ })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(container.innerHTML).not.toContain('@example')
  })
})

describe('the list’s four states', () => {
  const params = parseDomainListParams({})

  it('lists the domains with their facts, linked by id', () => {
    render(
      <DomainsList
        side="test"
        params={params}
        list={{
          rows: [
            listRow(),
            listRow({
              id: ORDER,
              name: 'demo.ng',
              source: 'demo',
              status: null,
              expiresAt: null,
              registryCheckedAt: null,
              delegation: null,
              userId: null,
            }),
          ],
          total: 2,
        }}
        now={NOW}
      />,
    )
    const table = screen.getByRole('table', { name: 'Domains on the Test side, page 1 of 1' })
    expect(within(table).getByRole('link', { name: 'getpaid.com' })).toHaveAttribute(
      'href',
      `/admin/domains/${DOMAIN}`,
    )
    expect(within(table).getByText('Pointed and working')).toBeInTheDocument()
    expect(within(table).getByText('(in 148 days)')).toBeInTheDocument()
    expect(within(table).getAllByText('On — turning off')).toHaveLength(2)
    expect(within(table).getByRole('link', { name: 'Account 2a2b2c2d' })).toHaveAttribute(
      'href',
      `/admin/customers/${USER}`,
    )
    expect(within(table).getByText('Demo')).toBeInTheDocument()
    expect(within(table).getAllByText('Not read yet')).toHaveLength(1)
    expect(within(table).getByRole('columnheader', { name: /Expires/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByText('2 in all')).toBeInTheDocument()
  })

  it('refuses an email search in words, with the ways on', () => {
    render(
      <DomainsList
        side="live"
        params={parseDomainListParams({ q: 'ada@example.com' })}
        list={null}
        now={NOW}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('An email address is never put in a link')
    expect(screen.getByRole('link', { name: 'Go to Customers' })).toHaveAttribute(
      'href',
      '/admin/customers',
    )
    expect(screen.getByRole('link', { name: 'Show domains without a search' })).toHaveAttribute(
      'href',
      '/admin/domains',
    )
  })

  it('says a search it cannot use is unknown', () => {
    render(
      <DomainsList
        side="live"
        params={parseDomainListParams({ q: 'get paid' })}
        list={null}
        now={NOW}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('That isn’t a domain or part of one.')
    expect(screen.queryByRole('link', { name: 'Go to Customers' })).toBeNull()
  })

  it('shows an error with Try again when the list cannot be read', () => {
    render(<DomainsList side="live" params={params} list={null} now={NOW} />)
    expect(screen.getByRole('alert')).toHaveTextContent("The domains couldn't be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('says nothing matches a filter, or that the side holds nothing yet', () => {
    const { rerender } = render(
      <DomainsList
        side="live"
        params={parseDomainListParams({ tld: 'ng' })}
        list={{ rows: [], total: 0 }}
        now={NOW}
      />,
    )
    expect(screen.getByText('No domains match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute(
      'href',
      '/admin/domains',
    )
    rerender(<DomainsList side="test" params={params} list={{ rows: [], total: 0 }} now={NOW} />)
    expect(screen.getByText('No domains on the Test side yet.')).toBeInTheDocument()
  })

  it('offers the first page when a page is past the end', () => {
    render(
      <DomainsList
        side="live"
        params={parseDomainListParams({ page: '9' })}
        list={{ rows: [], total: 30 }}
        now={NOW}
      />,
    )
    expect(screen.getByText('Nothing on page 9.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/domains',
    )
  })
})

describe('Ours and the registry', () => {
  const ours = {
    status: 'active',
    expiresAt: '2027-03-01T10:00:00Z',
    transferLock: true,
    privacy: false,
    nameservers: ['ns1.example-dns.net'],
  }

  it('shows what the hourly check stored, and reads the registry only on a click', async () => {
    vi.mocked(lookupDomain).mockResolvedValue({
      data: {
        ok: true,
        auditId: 1,
        data: {
          name: 'getpaid.com',
          outcome: 'not_found',
          status: null,
          statusCode: null,
          expiresAt: null,
          rgpExpiresAt: null,
          transferLock: null,
          privacy: null,
          nameservers: [],
          readAt,
        },
      },
    } as never)
    const user = userEvent.setup()
    render(
      <RegistryCompare
        name="getpaid.com"
        ours={ours}
        stored={{ registryStatus: 'Active', checkedAt: '2026-10-03T10:00:00Z' }}
        returnTo="/admin/domains"
      />,
    )
    expect(lookupDomain).not.toHaveBeenCalled()
    const table = screen.getByRole('table')
    expect(
      within(table).getByRole('row', { name: /Status Active Active Same/ }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: REGISTRY.read }))
    expect(lookupDomain).toHaveBeenCalledWith({ name: 'getpaid.com' })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^1 field differs\./))
    expect(
      within(screen.getByRole('table')).getByRole('row', {
        name: /Status Active Not in our account Differs/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Our record beside the registry, read at 12:05 WAT.'),
    ).toBeInTheDocument()
  })

  it('says when every field matches', async () => {
    vi.mocked(lookupDomain).mockResolvedValue({
      data: {
        ok: true,
        auditId: 1,
        data: {
          name: 'getpaid.com',
          outcome: 'ok',
          status: 'Active',
          statusCode: '0',
          expiresAt: '2027-03-01T10:00:00Z',
          rgpExpiresAt: null,
          transferLock: true,
          privacy: false,
          nameservers: ['ns1.example-dns.net'],
          readAt,
        },
      },
    } as never)
    const user = userEvent.setup()
    render(
      <RegistryCompare
        name="getpaid.com"
        ours={ours}
        stored={{ registryStatus: null, checkedAt: null }}
        returnTo="/admin/domains"
      />,
    )
    await user.click(screen.getByRole('button', { name: REGISTRY.read }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(REGISTRY.same))
  })

  it('says a refused, empty or lost read in words', async () => {
    vi.mocked(lookupDomain)
      .mockResolvedValueOnce({
        data: { ok: false, code: 'NO_GATEWAY', message: ADMIN_ERROR_WORDS.NO_GATEWAY },
      } as never)
      .mockResolvedValueOnce({ data: { ok: true, auditId: 2 } } as never)
      .mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    render(
      <RegistryCompare
        name="getpaid.com"
        ours={ours}
        stored={{ registryStatus: null, checkedAt: null }}
        returnTo="/admin/domains"
      />,
    )
    const button = screen.getByRole('button', { name: REGISTRY.read })
    await user.click(button)
    expect(await screen.findByText(ADMIN_ERROR_WORDS.NO_GATEWAY as string)).toBeInTheDocument()
    await user.click(button)
    expect(await screen.findByText(REGISTRY.nothing)).toBeInTheDocument()
    await user.click(button)
    expect(await screen.findByText(REGISTRY.lost)).toBeInTheDocument()
  })

  it('says why the registry cannot be read from here', () => {
    render(
      <RegistryCompare
        name="getpaid.com"
        ours={ours}
        stored={{ registryStatus: null, checkedAt: null }}
        readOff={REGISTRY.roleOnly}
        returnTo="/admin/domains"
      />,
    )
    expect(screen.getByText(REGISTRY.roleOnly)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('registrant verification', () => {
  it('reads it on a click and says what it found', async () => {
    vi.mocked(readRegistrantVerification)
      .mockResolvedValueOnce({
        data: {
          ok: true,
          auditId: 3,
          data: {
            name: 'getpaid.com',
            isVerified: true,
            operationStatus: null,
            verifiedAt: null,
            fieldType: 'Email',
            readAt,
          },
        },
      } as never)
      .mockResolvedValueOnce({ data: { ok: true, auditId: 4, data: null } } as never)
      .mockResolvedValueOnce({
        data: { ok: false, code: 'ADMIN_DISABLED', message: ADMIN_ERROR_WORDS.ADMIN_DISABLED },
      } as never)
      .mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    render(<VerificationRead name="getpaid.com" canRead returnTo="/admin/domains" />)
    const button = screen.getByRole('button', { name: 'Read registrant verification' })
    await user.click(button)
    expect(readRegistrantVerification).toHaveBeenCalledWith({ name: 'getpaid.com' })
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Read at 12:05 WAT: verified (Email)'),
    )
    await user.click(button)
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'the registry lists no verification for this domain',
      ),
    )
    await user.click(button)
    expect(await screen.findByText(ADMIN_ERROR_WORDS.ADMIN_DISABLED as string)).toBeInTheDocument()
    await user.click(button)
    expect(await screen.findByText(REGISTRY.lost)).toBeInTheDocument()
  })

  it('tells a viewer it is not theirs to read', () => {
    render(<VerificationRead name="getpaid.com" canRead={false} returnTo="/admin/domains" />)
    expect(
      screen.getByText("Your admin role can't read the registrant's verification."),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the registrant', () => {
  const props = {
    domainId: DOMAIN,
    name: 'getpaid.com',
    country: 'Nigeria (NG)',
    type: 'Individual',
    hasRegistrant: true,
    canReveal: true,
    returnTo: `/admin/domains/${DOMAIN}`,
  }

  it('shows the summary, and the rest only after an audited reveal', async () => {
    vi.mocked(revealRegistrant).mockResolvedValue({
      data: {
        ok: true,
        auditId: 21,
        data: {
          registrant: {
            firstName: 'Ada',
            lastName: 'Obi',
            email: 'ada@example.net',
            phoneCountryCode: '234',
            phone: '8030000000',
            addressLine1: '1 Marina',
            city: 'Lagos',
            zipCode: '100001',
            country: 'NG',
          },
          contacts: [
            { role: 'technical', contact: { firstName: 'Tech', email: 'tech@example.net' } },
          ],
        },
      },
    } as never)
    const user = userEvent.setup()
    const { unmount } = render(<RegistrantPanel {...props} />)
    expect(screen.getByText('Nigeria (NG)')).toBeInTheDocument()
    expect(screen.getByText('Individual')).toBeInTheDocument()
    expect(screen.getByText(REVEAL.hidden)).toBeInTheDocument()
    expect(screen.queryByText('ada@example.net')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Show registrant' }))
    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog).getByRole('heading', { name: 'Show the registrant of getpaid.com?' }),
    ).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Your view is recorded in the audit log.')
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'customer asked')
    await user.click(within(dialog).getByRole('button', { name: 'Show registrant' }))
    await waitFor(() => expect(within(dialog).getByText(REVEAL.done)).toBeInTheDocument())
    expect(revealRegistrant).toHaveBeenCalledWith({
      domainId: DOMAIN,
      reason: 'customer asked',
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))

    expect(screen.getByText('ada@example.net')).toBeInTheDocument()
    expect(screen.getByText('Ada Obi')).toBeInTheDocument()
    expect(screen.getByText('+234 8030000000')).toBeInTheDocument()
    expect(screen.getByText('Lagos 100001')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Technical contact' })).toBeInTheDocument()
    expect(screen.getByText('tech@example.net')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: REVEAL.hide }))
    expect(screen.queryByText('ada@example.net')).toBeNull()
    expect(screen.getByText(REVEAL.hidden)).toBeInTheDocument()
    unmount()
  })

  it('says a replayed request in words, with nothing shown', async () => {
    vi.mocked(revealRegistrant).mockResolvedValue({
      data: { ok: false, code: 'REPLAYED', message: ADMIN_ERROR_WORDS.REPLAYED, auditId: 22 },
    } as never)
    const user = userEvent.setup()
    render(<RegistrantPanel {...props} />)
    await user.click(screen.getByRole('button', { name: 'Show registrant' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Show registrant' }))
    expect(
      await within(dialog).findByText(ADMIN_ERROR_WORDS.REPLAYED as string),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Registrant$/, { selector: 'h3' })).toBeNull()
  })

  it('shows contacts alone when no registrant came back, and says the roles are the registrant', async () => {
    vi.mocked(revealRegistrant).mockResolvedValue({
      data: { ok: true, auditId: 23, data: { registrant: null, contacts: [] } },
    } as never)
    const user = userEvent.setup()
    render(<RegistrantPanel {...props} />)
    await user.click(screen.getByRole('button', { name: 'Show registrant' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Show registrant' }),
    )
    await user.click(
      await within(screen.getByRole('dialog')).findByRole('button', { name: 'Close' }),
    )
    expect(screen.getByText(REVEAL.none)).toBeInTheDocument()
  })

  it('offers nothing to reveal without a registrant, or to a viewer', () => {
    const { rerender } = render(<RegistrantPanel {...props} hasRegistrant={false} />)
    expect(screen.getByText(REVEAL.none)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<RegistrantPanel {...props} canReveal={false} />)
    expect(screen.getByText(REVEAL.roleOnly)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('Queue a deep sync', () => {
  it('asks first, in the spec’s words, then queues it', async () => {
    vi.mocked(queueDeepSync).mockResolvedValue({
      data: { ok: true, auditId: 31, after: { queued: true } },
    } as never)
    const user = userEvent.setup()
    render(<DeepSyncButton domainId={DOMAIN} name="getpaid.com" returnTo="/admin/domains" />)
    await user.click(screen.getByRole('button', { name: DEEP_SYNC.trigger }))
    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog).getByRole('heading', {
        name: 'Read getpaid.com from the registry on the next sync?',
      }),
    ).toBeInTheDocument()
    expect(dialog).toHaveTextContent(DEEP_SYNC.body)
    await user.click(within(dialog).getByRole('button', { name: DEEP_SYNC.confirm }))
    expect(await within(dialog).findByText(DEEP_SYNC.done)).toBeInTheDocument()
    expect(queueDeepSync).toHaveBeenCalledWith({
      domainId: DOMAIN,
      reason: undefined,
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the database’s refusal in words', async () => {
    vi.mocked(queueDeepSync).mockResolvedValue({
      data: { ok: false, code: 'NO_GATEWAY', message: ADMIN_ERROR_WORDS.NO_GATEWAY, auditId: 32 },
    } as never)
    const user = userEvent.setup()
    render(<DeepSyncButton domainId={DOMAIN} name="getpaid.com" returnTo="/admin/domains" />)
    await user.click(screen.getByRole('button', { name: DEEP_SYNC.trigger }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: DEEP_SYNC.confirm }))
    expect(
      await within(dialog).findByText(ADMIN_ERROR_WORDS.NO_GATEWAY as string),
    ).toBeInTheDocument()
  })
})

describe('one domain', () => {
  it('shows every part, with the live reads as buttons and no read on render', () => {
    render(<DomainDetailBody detail={detail()} side="test" viewer={operator} now={NOW} />)
    expect(screen.getByRole('heading', { level: 1, name: 'getpaid.com' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Admin/Domains/Domain',
    )
    const summary = screen.getByRole('region', { name: 'Summary' })
    expect(within(summary).getByRole('link', { name: 'ND-001035' })).toHaveAttribute(
      'href',
      `/admin/orders/${ORDER}`,
    )
    expect(
      within(summary).getByText('ns1.example-dns.net, ns2.example-dns.net'),
    ).toBeInTheDocument()
    expect(within(summary).getByText(/typed by hand or the registrar/)).toBeInTheDocument()
    const registry = screen.getByRole('region', { name: 'Ours and the registry' })
    expect(within(registry).getByRole('button', { name: REGISTRY.read })).toBeInTheDocument()
    expect(within(registry).getByText(/Registry renewal mode 'AutoRenew'/)).toBeInTheDocument()
    const registrant = screen.getByRole('region', { name: 'Registrant' })
    expect(within(registrant).getByText('Nigeria (NG)')).toBeInTheDocument()
    expect(within(registrant).getByRole('button', { name: 'Show registrant' })).toBeInTheDocument()
    expect(
      within(registrant).getByRole('button', { name: 'Read registrant verification' }),
    ).toBeInTheDocument()
    const sync = screen.getByRole('region', { name: 'Deep sync' })
    expect(within(sync).getByText(DEEP_SYNC.waiting)).toBeInTheDocument()
    expect(within(sync).getByRole('button', { name: DEEP_SYNC.trigger })).toBeInTheDocument()
    expect(within(sync).queryByText(DEEP_SYNC.noGateway('test'))).toBeNull()
    const jobs = screen.getByRole('region', { name: 'Jobs' })
    expect(within(jobs).getAllByRole('link', { name: 'Registration' })[0]).toHaveAttribute(
      'href',
      `/admin/queue/jobs/${JOB}`,
    )
    expect(
      screen.getByText('The registry checks have found nothing different for this domain.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText("The nameservers haven't changed since this domain was added."),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Timeline' })).getByText('Registered'),
    ).toBeInTheDocument()
    expect(lookupDomain).not.toHaveBeenCalled()
    expect(readRegistrantVerification).not.toHaveBeenCalled()
  })

  it('says no sandbox gateway is reading test domains when its heartbeat is stale', () => {
    render(
      <DomainDetailBody
        detail={detail({}, { gateway: { kind: 'read', beatAt: '2026-10-03T10:00:00Z' } })}
        side="test"
        viewer={operator}
        now={NOW}
      />,
    )
    expect(screen.getByText(DEEP_SYNC.noGateway('test'))).toBeInTheDocument()
  })

  it('tells a test admin the gateway is not shown to them', () => {
    render(
      <DomainDetailBody
        detail={detail({}, { gateway: { kind: 'hidden' } })}
        side="test"
        viewer={testAdmin}
        now={NOW}
      />,
    )
    expect(screen.getByText(DEEP_SYNC.gatewayHidden)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: DEEP_SYNC.trigger })).toBeInTheDocument()
  })

  it('gives a viewer the facts, not the buttons', () => {
    render(<DomainDetailBody detail={detail()} side="live" viewer={viewer} now={NOW} />)
    expect(screen.getByText(REGISTRY.roleOnly)).toBeInTheDocument()
    expect(screen.getByText(REVEAL.roleOnly)).toBeInTheDocument()
    expect(screen.getByText(DEEP_SYNC.roleOnly)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: REGISTRY.read })).toBeNull()
  })

  it('offers no registry read or sync on a demo domain, and says why', () => {
    render(
      <DomainDetailBody
        detail={detail({ source: 'demo', deepCheckedAt: '2026-10-02T09:00:00Z' })}
        side="live"
        viewer={operator}
        now={NOW}
      />,
    )
    expect(screen.getAllByText(DEEP_SYNC.demo).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: DEEP_SYNC.trigger })).toBeNull()
    expect(
      screen.getByText('Last read by the deep sync 2 Oct 2026 at 10:00 WAT.'),
    ).toBeInTheDocument()
  })

  it('shows drift, history, the preset and pending changes, and each part’s own error', () => {
    render(
      <DomainDetailBody
        detail={detail(
          {
            status: 'pending',
            presetId: ORDER,
            pendingNameservers: ['ns1.new.net', 'ns2.new.net'],
          },
          {
            preset: { ok: true, data: { id: ORDER, provider: 'Vercel' } },
            drift: {
              ok: true,
              data: [
                {
                  id: 9,
                  kind: 'status_mismatch',
                  ours: 'Status active',
                  registry: 'Status ClientHold',
                  firstSeenAt: '2026-10-01T10:00:00Z',
                  lastSeenAt: '2026-10-03T10:00:00Z',
                  resolvedAt: null,
                },
                {
                  id: 8,
                  kind: 'supplier_renewed',
                  ours: 'Expires 1 Mar 2027',
                  registry: 'Expires 1 Mar 2028',
                  firstSeenAt: '2026-09-01T10:00:00Z',
                  lastSeenAt: '2026-09-02T10:00:00Z',
                  resolvedAt: '2026-09-03T10:00:00Z',
                },
              ],
            },
            history: {
              ok: true,
              data: [
                { id: 1, before: null, after: ['ns1.a.net'], changedAt: '2026-09-02T10:00:00Z' },
              ],
            },
            jobs: { ok: false },
            events: { ok: false },
            line: { ok: false },
            gateway: { kind: 'failed' },
          },
        )}
        side="live"
        viewer={operator}
        now={NOW}
      />,
    )
    expect(screen.getByRole('link', { name: 'Vercel' })).toHaveAttribute(
      'href',
      `/admin/settings/presets/${ORDER}`,
    )
    expect(screen.getByText('Changing to ns1.new.net, ns2.new.net')).toBeInTheDocument()
    const drift = screen.getByRole('region', { name: 'Registry drift' })
    expect(within(drift).getAllByText('Status differs')[0]).toBeInTheDocument()
    expect(within(drift).getAllByText('Open')[0]).toBeInTheDocument()
    expect(within(drift).getAllByText('Resolved')[0]).toBeInTheDocument()
    expect(within(drift).getByRole('link', { name: 'All open drift' })).toHaveAttribute(
      'href',
      '/admin/alerts?tab=drift',
    )
    const history = screen.getByRole('region', { name: 'Nameserver history' })
    expect(within(history).getAllByText('ns1.a.net')[0]).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Jobs' })).getByRole('alert'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Timeline' })).getByRole('alert'),
    ).toBeInTheDocument()
    // A line that could not be read still says which line it is.
    expect(screen.getByText('Line 3a3b3c3d')).toBeInTheDocument()
    expect(screen.getByText(DEEP_SYNC.notSyncable)).toBeInTheDocument()
  })

  it('links to every job when there are more than it shows', () => {
    render(
      <DomainDetailBody
        detail={detail(
          {},
          {
            jobs: {
              ok: true,
              data: { total: 14, rows: [] },
            },
          },
        )}
        side="live"
        viewer={operator}
        now={NOW}
      />,
    )
    expect(screen.getByRole('link', { name: 'All 14 jobs' })).toHaveAttribute(
      'href',
      `/admin/queue?domain=${DOMAIN}`,
    )
    expect(screen.getByText('No jobs for this domain.')).toBeInTheDocument()
  })

  it('says a domain is not on this side, with the way back', () => {
    render(<DomainNotFound side="test" />)
    expect(screen.getByText("This domain isn't on the Test side.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to domains' })).toHaveAttribute(
      'href',
      '/admin/domains',
    )
  })
})
