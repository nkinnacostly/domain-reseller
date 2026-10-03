import { render, screen, within } from '@testing-library/react'
import { cookies } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainView } from '@/features/admin/components/domains/domain-view'
import { DomainsView } from '@/features/admin/components/domains/domains-view'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { fakeService, ids } from '../orders/fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`)
  },
}))
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute: vi.fn(), isPending: false, result: {} }),
}))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))
vi.mock('@/features/admin/actions/domains', () => ({
  queueDeepSync: vi.fn(),
  revealRegistrant: vi.fn(),
}))
vi.mock('@/features/admin/actions/supplier-live', () => ({
  lookupDomain: vi.fn(),
  readRegistrantVerification: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
// requireAdmin is React's cache(): outside a render it would remember one answer.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T,>(fn: T) => fn,
}))

const domain = {
  id: ids.domain,
  domain_name: 'getpaid.com',
  tld: 'com',
  source: 'registration',
  test_mode: false,
  user_id: ids.user,
  local_status: 'active',
  expires_at: '2027-03-01T10:00:00Z',
  auto_renew: true,
  transfer_lock: true,
  pending_transfer_lock: null,
  privacy_enabled: false,
  pending_privacy: null,
  delegation_status: 'verified',
  registry_status: 'Active',
  registry_checked_at: '2026-10-03T10:00:00Z',
  created_at: '2026-09-01T10:00:00Z',
  order_item_id: null,
  registered_at: '2026-03-01T10:00:00Z',
  updated_at: '2026-10-02T10:00:00Z',
  nameservers: ['ns1.example-dns.net', 'ns2.example-dns.net'],
  pending_nameservers: null,
  previous_nameservers: null,
  nameserver_preset_id: null,
  delegation_checked_at: null,
  registry_renewal_mode: 'AutoRenew',
  deep_checked_at: null,
  registrant_country: 'NG',
  registrant_type: 'organisation',
}

const stats = {
  byTldStatus: [{ tld: 'com', status: 'active', count: 1 }],
  expiries: { expired: 0, d30: 0, d60: 0, d90: 0, autoOn90: 0, autoOff90: 0, next: null },
  delegation: [{ status: 'verified', count: 1 }],
  registryAutoRenewLabel: [{ mode: 'AutoRenew', count: 1 }],
}

function signedIn(
  side?: 'live' | 'test',
  admin: Record<string, unknown> = {},
  statsAnswer: { data?: unknown; error?: { message: string } } = { data: stats },
) {
  vi.mocked(cookies).mockResolvedValue({
    get: () => (side ? { name: 'dr_admin_side', value: side } : undefined),
  } as never)
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami(admin) }, admin_domain_stats: statsAnswer },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
})

describe('the domains list page', () => {
  it('shows the figures, the filters and the side’s domains, with the side switch', async () => {
    const session = signedIn()
    fakeService((read) =>
      read.table === 'admin_domains_v' ? { data: [domain], count: 1 } : undefined,
    )
    render(await DomainsView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('heading', { level: 1, name: 'Domains' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'At a glance' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search domains' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '1 domain' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('table', { name: /Domains on the Live side/ })).getByRole('link', {
        name: 'getpaid.com',
      }),
    ).toHaveAttribute('href', `/admin/domains/${ids.domain}`)
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true')
    expect(session.rpc).toHaveBeenCalledWith('admin_domain_stats', { p_test_mode: false })
  })

  it('keeps the filters when the list and the figures cannot be read', async () => {
    signedIn('test', {}, { error: { message: 'admin:test_admin' } })
    fakeService(() => ({ error: { message: 'boom', code: '57014' } }))
    render(await DomainsView({ searchParams: Promise.resolve({ status: 'active' }) }))
    expect(screen.getByText("The domain figures couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByText("The domains couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Domains' })).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Filter domains' })).toBeInTheDocument()
  })

  it('reads nothing for a search it refuses', async () => {
    signedIn()
    const reads = fakeService(() => ({ data: [] }))
    render(await DomainsView({ searchParams: Promise.resolve({ q: 'ada@example.com' }) }))
    expect(reads.filter((read) => read.table === 'admin_domains_v')).toHaveLength(0)
    expect(screen.getByRole('link', { name: 'Go to Customers' })).toBeInTheDocument()
  })
})

describe('the domain page', () => {
  it('shows the domain with its registrant summary, and nothing of the registrant itself', async () => {
    signedIn()
    const reads = fakeService((read) =>
      read.table === 'admin_domains_v' ? { data: [domain] } : { data: [] },
    )
    render(await DomainView({ params: Promise.resolve({ id: ids.domain.toUpperCase() }) }))
    expect(screen.getByRole('heading', { level: 1, name: 'getpaid.com' })).toBeInTheDocument()
    const registrant = screen.getByRole('region', { name: 'Registrant' })
    expect(within(registrant).getByText('Nigeria (NG)')).toBeInTheDocument()
    expect(within(registrant).getByText('Organisation')).toBeInTheDocument()
    expect(within(registrant).getByRole('button', { name: 'Show registrant' })).toBeInTheDocument()
    const [view] = reads.filter((read) => read.table === 'admin_domains_v')
    expect(view?.filters).toContainEqual(['eq', 'id', ids.domain])
    // The owner sees whether a gateway is reading the side: the heartbeat is read.
    expect(reads.some((read) => read.table === 'service_heartbeats')).toBe(true)
    expect(screen.getByText(/No gateway is reading live domains right now/)).toBeInTheDocument()
  })

  it('says a domain is not on this side, with the way back', async () => {
    signedIn('test')
    fakeService(() => ({ data: [] }))
    render(await DomainView({ params: Promise.resolve({ id: ids.domain }) }))
    expect(screen.getByText("This domain isn't on the Test side.")).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Domain' })).toBeInTheDocument()
  })

  it('reads nothing for an id that is not one', async () => {
    signedIn()
    const reads = fakeService(() => ({ data: [] }))
    render(await DomainView({ params: Promise.resolve({ id: 'getpaid.com' }) }))
    expect(reads).toHaveLength(0)
    expect(screen.getByText("This domain isn't on the Live side.")).toBeInTheDocument()
  })

  it('shows an error with a way on when the domain cannot be read', async () => {
    signedIn()
    fakeService(() => ({ error: { message: 'boom' } }))
    render(await DomainView({ params: Promise.resolve({ id: ids.domain }) }))
    expect(screen.getByRole('alert')).toHaveTextContent("This domain couldn't be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
