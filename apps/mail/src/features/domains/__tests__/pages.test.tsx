import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { createClient } from '@/lib/supabase/server'
import { useFakeDoh, useFakeSes } from '../../../../tests/mocks/ses'
import { domainRow, fakeReads } from './fake-reads'

/**
 * The Domains pages (MAIL-SPEC §5, §10) as each role sees them: the list and
 * its empty and error states (S11), the sandbox sender, and one domain with
 * its state, records, checks and removal.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/features/accounts/queries/accounts', () => ({ getCurrentAccount: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/domains',
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('../actions/domains', () => ({
  addDomain: vi.fn(),
  checkDomain: vi.fn(),
  removeDomain: vi.fn(),
  retryDomain: vi.fn(),
}))
vi.mock('../components/live-records', () => ({
  LiveRecords: () => <p>Live records</p>,
}))

const { DomainsPage } = await import('../components/domains-page')
const { DomainPage } = await import('../components/domain-page')

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const DOMAIN = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'

function as(role: string) {
  vi.mocked(getCurrentAccount).mockResolvedValue({
    user: { id: 'u' },
    memberships: [],
    current: { role, account: { id: ACCOUNT, name: 'Acme', state: 'sandbox' } },
  } as never)
}

function reads(tables: Parameters<typeof fakeReads>[0]) {
  vi.mocked(createClient).mockResolvedValue(fakeReads(tables).client as never)
}

beforeEach(() => vi.clearAllMocks())

describe('the Domains page', () => {
  it('empty, for a developer: the form and what to do', async () => {
    as('developer')
    reads({
      domains: { data: [], error: null },
      accounts: { data: { tenant_ready_at: null }, error: null },
    })
    render(await DomainsPage())
    expect(screen.getByRole('heading', { level: 1, name: 'Domains' })).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Add a domain' })).toBeInTheDocument()
    expect(screen.getByText('No domains yet')).toBeInTheDocument()
    expect(screen.getByText(/sending set-up with Amazon SES is being made/)).toBeInTheDocument()
  })

  it('a viewer reads, and is told who changes domains', async () => {
    as('viewer')
    reads({
      domains: { data: [domainRow()], error: null },
      accounts: { data: { tenant_ready_at: '2026-10-06T09:00:00Z' }, error: null },
    })
    render(await DomainsPage())
    expect(screen.queryByRole('form', { name: 'Add a domain' })).not.toBeInTheDocument()
    expect(
      screen.getByText(/Owners, admins and developers add and remove them/),
    ).toBeInTheDocument()
    expect(screen.getByText('acme.example')).toBeInTheDocument()
    expect(screen.queryByText(/being made/)).not.toBeInTheDocument()
  })

  it('the sandbox sender, once joined to this account', async () => {
    as('owner')
    reads({
      domains: {
        data: [
          domainRow({
            id: 's',
            name: 'sandbox.emails.mydomainshub.com',
            kind: 'sandbox',
            status: 'sandbox',
          }),
        ],
        error: null,
      },
      sandbox_identity: {
        data: { from_address: 'onboarding@sandbox.emails.mydomainshub.com', status: 'verified' },
        error: null,
      },
      accounts: { data: { tenant_ready_at: '2026-10-06T09:00:00Z' }, error: null },
    })
    render(await DomainsPage())
    expect(screen.getByText('onboarding@sandbox.emails.mydomainshub.com')).toBeInTheDocument()
    expect(screen.getByText('No domains yet')).toBeInTheDocument()
  })

  it('domains it could not read: said, with a way to try again', async () => {
    as('owner')
    reads({ domains: { data: null, error: { code: '08006' } } })
    render(await DomainsPage())
    expect(screen.getByRole('alert')).toHaveTextContent('We couldn’t load your domains')
  })

  it('nothing without an account', async () => {
    vi.mocked(getCurrentAccount).mockResolvedValue(null)
    expect(await DomainsPage()).toBeNull()
  })
})

describe('one domain', () => {
  const page = async (id = DOMAIN) => DomainPage({ params: Promise.resolve({ id }) })

  it('pending: its state, its deadline, "Check now", the records and the host guides', async () => {
    as('developer')
    reads({ domains: { data: domainRow(), error: null } })
    render((await page()) as React.ReactElement)
    expect(screen.getByRole('heading', { level: 1, name: 'acme.example' })).toBeInTheDocument()
    expect(screen.getByText('Waiting for DNS')).toBeInTheDocument()
    expect(screen.getByText('To verify by')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument()
    expect(screen.getByText('Live records')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Where to add them' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove domain' })).toBeInTheDocument()
  })

  it('setting up: no records yet, and said so', async () => {
    as('developer')
    reads({
      domains: { data: domainRow({ dkim_tokens: [], identity_created_at: null }), error: null },
    })
    render((await page()) as React.ReactElement)
    expect(screen.getByText('Setting up')).toBeInTheDocument()
    expect(
      screen.getByText(/records appear here as soon as Amazon SES gives them/),
    ).toBeInTheDocument()
  })

  it('failed: why, the record it missed, and "Try again"', async () => {
    as('owner')
    reads({
      domains: {
        data: domainRow({
          status: 'failed',
          failed_reason: 'dkim_record_missing',
          missing_record: 'x._domainkey.acme.example',
          released_at: '2026-10-09T09:40:00+00:00',
        }),
        error: null,
      },
    })
    render((await page()) as React.ReactElement)
    expect(screen.getByText(/x\._domainkey\.acme\.example was not found/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument()
  })

  it('verified, for a viewer: no changes offered', async () => {
    as('viewer')
    reads({
      domains: {
        data: domainRow({ status: 'verified', verified_at: '2026-10-06T10:00:00+00:00' }),
        error: null,
      },
    })
    render((await page()) as React.ReactElement)
    expect(screen.getByText('Verified', { selector: 'dt' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove domain' })).not.toBeInTheDocument()
  })

  it('not this account’s, or unreadable', async () => {
    as('owner')
    reads({ domains: { data: null, error: null } })
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND')
    reads({ domains: { data: null, error: { code: '08006' } } })
    render((await page()) as React.ReactElement)
    expect(screen.getByRole('alert')).toHaveTextContent('We couldn’t load this domain')
    vi.mocked(getCurrentAccount).mockResolvedValue(null)
    expect(await page()).toBeNull()
  })
})

describe('the live records', () => {
  it('asks public DNS and shows each record’s state', async () => {
    const ses = useFakeSes()
    useFakeDoh(ses)
    const { LiveRecords } = await vi.importActual<typeof import('../components/live-records')>(
      '../components/live-records',
    )
    const { domainRecords } = await import('../lib/records')
    const records = domainRecords({
      name: 'acme.example',
      dkimTokens: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'],
      mailFromDomain: null,
      region: 'eu-west-2',
    })
    render(await LiveRecords({ records, zone: 'acme.example' }))
    expect(screen.getAllByText('Not found yet').length).toBe(records.length)
  })
})
