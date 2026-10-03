import { render, screen, within } from '@testing-library/react'
import { cookies } from 'next/headers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CustomerCertificatesTab,
  CustomerDomainsTab,
  CustomerEmailsTab,
  CustomerOrdersTab,
} from '@/features/admin/components/customers/customer-tabs'
import { CustomerView } from '@/features/admin/components/customers/customer-view'
import { CustomersView } from '@/features/admin/components/customers/customers-view'
import { parseCustomer } from '@/features/admin/lib/customers-data'
import { createClient } from '@/lib/supabase/server'
import { sessionClient, whoami } from '../foundation/fixtures'
import { customerJson, customerRow, fakeService, ids, principal } from './fake-db'

/**
 * The customers pages as rendered (ADMIN-SPEC §5.2 B8): the list with its
 * four states, one customer behind `admin_customer`'s say-so, and each tab.
 */

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => `/admin/customers/${'2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d'}`,
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
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))
vi.mock('@/features/admin/actions/customers', () => ({
  findCustomers: vi.fn(),
  revealCustomer: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))
// requireAdmin is React's cache(): outside a render it would remember one answer.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  cache: <T,>(fn: T) => fn,
}))

type Rpc = NonNullable<Parameters<typeof sessionClient>[0]>['rpc']

function signedIn(rpc: Rpc = {}, who: Record<string, unknown> = {}, side?: 'live' | 'test') {
  vi.mocked(cookies).mockResolvedValue({
    get: () => (side ? { name: 'dr_admin_side', value: side } : undefined),
  } as never)
  const session = sessionClient({
    rpc: { admin_whoami: { data: whoami({ role: 'operator', label: 'ops', ...who }) }, ...rpc },
  })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session
}

const stats = {
  profiles: 7,
  confirmed: 6,
  liveBuyers: 2,
  mfaUsers: 1,
  holders: 2,
  active30d: 5,
  over10NoMfa: 0,
  signupsByDay: [{ day: '2026-10-02', count: 1 }],
}

const params = Promise.resolve({ id: ids.user })

beforeEach(() => vi.clearAllMocks())

describe('the customers list page', () => {
  it('shows the totals, the search and the side’s accounts, masked, with the side switch', async () => {
    const session = signedIn({
      admin_customer_stats: { data: stats },
      admin_customers: { data: [customerRow({ total_count: 1 })] },
    })
    render(await CustomersView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Accounts' })).toHaveTextContent('Real accounts only')
    expect(
      screen.getByRole('searchbox', { name: 'Email, order number or domain' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'All customers · 1' })).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Customers, Live side counts, page 1 of 1' })
    expect(within(table).getByText('a•••@gmail.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true')
    expect(session.rpc).toHaveBeenCalledWith(
      'admin_customers',
      expect.objectContaining({ p_test_mode: false, p_sort: 'joined', p_dir: 'desc' }),
    )
  })

  it('shows a test admin no totals and asks SQL for none', async () => {
    const session = signedIn(
      { admin_customers: { data: [] } },
      { testOnly: true, label: 'e2e-ops' },
    )
    render(await CustomersView({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('region', { name: 'Accounts' })).toHaveTextContent(
      'Not shown to test administrators.',
    )
    expect(session.rpc.mock.calls.map(([name]) => name)).not.toContain('admin_customer_stats')
    expect(screen.getByText('No e2e test accounts right now.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the totals and the search when the list cannot be read', async () => {
    signedIn({
      admin_customer_stats: { data: stats },
      admin_customers: { error: { message: 'boom', code: '57014' } },
    })
    render(await CustomersView({ searchParams: Promise.resolve({ holders: 'yes' }) }))
    expect(screen.getByText('The customers couldn’t be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'All customers' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
  })

  it('tells a viewer the search is not theirs', async () => {
    signedIn(
      { admin_customer_stats: { data: stats }, admin_customers: { data: [] } },
      { role: 'viewer' },
    )
    render(await CustomersView({ searchParams: Promise.resolve({}) }))
    expect(
      screen.getByText('Your admin role can’t look customers up. Ask the owner.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })
})

describe('the customer page', () => {
  it('shows the masked account, its tabs, counts, allowance and the reveal', async () => {
    signedIn({ admin_customer: { data: customerJson() } })
    render(await CustomerView({ params, tab: 'overview' }))
    expect(screen.getByRole('heading', { level: 1, name: 'a•••@gmail.com' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Admin/Customers/Account 2a2b2c2d',
    )
    const tabs = screen.getByRole('navigation', { name: 'Customer' })
    expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(tabs).getByRole('link', { name: 'Orders (2)' })).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}/orders`,
    )
    expect(screen.getByRole('region', { name: 'On the Live side' })).toHaveTextContent('₦20,103')
    expect(screen.getByRole('region', { name: 'New domains allowed' })).toHaveTextContent(
      '2 of 10 new domains in the last 24 hours · Standard',
    )
    expect(screen.getByRole('button', { name: 'Show contact details' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy account id' })).toBeInTheDocument()
  })

  it('says the allowance could not be read, and hides the reveal from a viewer', async () => {
    signedIn({ admin_customer: { data: customerJson({ allowance: null }) } }, { role: 'viewer' })
    render(await CustomerView({ params, tab: 'overview' }))
    expect(screen.getByText('The daily allowance couldn’t be read.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show contact details' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Your admin role can’t see contact details. Ask the owner.'),
    ).toBeInTheDocument()
  })

  it('tells a test admin a real account is not shown, and reads nothing else (D15)', async () => {
    signedIn(
      { admin_customer: { error: { message: 'admin:test_admin' } } },
      { testOnly: true, label: 'e2e-ops' },
    )
    const reads = fakeService(() => ({ data: [] }))
    render(await CustomerView({ params, tab: 'orders', searchParams: Promise.resolve({}) }))
    expect(screen.getByText('Not shown to test administrators.')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Customer' })).not.toBeInTheDocument()
    expect(reads).toEqual([])
  })

  it('says there is no such account, with the way back', async () => {
    signedIn({ admin_customer: { data: null } })
    render(await CustomerView({ params, tab: 'domains' }))
    expect(screen.getByText('No customer with this id.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to customers' })).toHaveAttribute(
      'href',
      '/admin/customers',
    )
  })

  it('shows an error with a way on when the account cannot be read', async () => {
    signedIn({ admin_customer: { error: { message: 'fetch failed' } } })
    render(await CustomerView({ params, tab: 'overview' }))
    expect(screen.getByRole('alert')).toHaveTextContent('This customer couldn’t be loaded.')
    expect(screen.getByRole('heading', { level: 1, name: 'Customer' })).toBeInTheDocument()
  })

  it('has an Emails tab, read once the account may be shown', async () => {
    signedIn({ admin_customer: { data: customerJson() } })
    render(await CustomerView({ params, tab: 'emails' }))
    expect(
      within(screen.getByRole('navigation', { name: 'Customer' })).getByRole('link', {
        name: 'Emails',
      }),
    ).toHaveAttribute('href', `/admin/customers/${ids.user}/emails`)
  })
})

describe('the tabs', () => {
  const customer = parseCustomer(customerJson())
  if (!customer) throw new Error('fixture')

  it('lists the orders, with what each bought and a pager', async () => {
    const admin = await principal({ role: 'operator' })
    fakeService((read) => {
      if (read.table === 'admin_orders_v') {
        return {
          data: [
            {
              id: ids.order,
              order_number: 'ND-001035',
              test_mode: true,
              status: 'completed',
              total_kobo: 2_010_250,
              created_at: '2026-10-02T09:00:00Z',
              paid_at: null,
              invoice_number: null,
            },
          ],
          count: 30,
        }
      }
      return { data: [{ order_id: ids.order, item_type: 'register' }] }
    })
    render(await CustomerOrdersTab({ admin, side: 'test', customer, page: 1 }))
    expect(screen.getByRole('heading', { level: 2, name: 'Orders · 30' })).toBeInTheDocument()
    const table = screen.getByRole('table', {
      name: 'This customer’s orders on the Test side, page 1 of 2',
    })
    expect(within(table).getByRole('link', { name: 'ND-001035' })).toHaveAttribute(
      'href',
      `/admin/orders/${ids.order}`,
    )
    expect(within(table).getByText('Registration')).toBeInTheDocument()
    expect(within(table).getByText('Not paid')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Next/ })).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}/orders?page=2`,
    )
  })

  it('says there are no orders, a page past the end, or that they could not be read', async () => {
    const admin = await principal({ role: 'operator' })
    fakeService(() => ({ data: [], count: 0 }))
    const { unmount } = render(await CustomerOrdersTab({ admin, side: 'live', customer, page: 1 }))
    expect(screen.getByText('No orders from this customer on the Live side.')).toBeInTheDocument()
    unmount()

    let asked = 0
    fakeService(() => {
      asked += 1
      return asked === 1 ? { error: { message: 'range', code: 'PGRST103' } } : { count: 3 }
    })
    const second = render(await CustomerOrdersTab({ admin, side: 'live', customer, page: 4 }))
    expect(screen.getByText('Nothing on page 4.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}/orders`,
    )
    second.unmount()

    fakeService(() => ({ error: { message: 'boom', code: '57014' } }))
    render(await CustomerOrdersTab({ admin, side: 'live', customer, page: 1 }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This part of the customer couldn’t be loaded.',
    )
  })

  it('lists the customer’s domains from the masked view, linked by id', async () => {
    const admin = await principal({ role: 'operator' })
    const reads = fakeService(() => ({
      data: [
        {
          id: ids.domain,
          domain_name: 'getpaid.com',
          local_status: 'active',
          expires_at: '2027-10-02T09:00:00Z',
          auto_renew: false,
          registered_at: '2026-10-02T09:00:00Z',
          created_at: '2026-10-02T08:00:00Z',
          test_mode: false,
        },
      ],
      count: 1,
    }))
    render(await CustomerDomainsTab({ admin, side: 'live', customer }))
    expect(reads.map((read) => read.table)).toEqual(['admin_domains_v'])
    expect(screen.getByRole('heading', { level: 2, name: 'Domains · 1' })).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getByRole('link', { name: 'getpaid.com' })).toHaveAttribute(
      'href',
      `/admin/domains/${ids.domain}`,
    )
    expect(within(table).getByText('Active')).toBeInTheDocument()
    expect(within(table).getByText('Off')).toBeInTheDocument()
  })

  it('says when there are no domains, and how many past the newest it shows', async () => {
    const admin = await principal({ role: 'operator' })
    fakeService(() => ({ data: [], count: 0 }))
    const empty = render(await CustomerDomainsTab({ admin, side: 'test', customer }))
    expect(screen.getByText('No domains for this customer on the Test side.')).toBeInTheDocument()
    empty.unmount()

    fakeService(() => ({
      data: [
        {
          id: ids.domain,
          domain_name: 'getpaid.com',
          local_status: 'active',
          expires_at: null,
          auto_renew: true,
          registered_at: null,
          created_at: '2026-10-02T08:00:00Z',
          test_mode: true,
        },
      ],
      count: 250,
    }))
    render(await CustomerDomainsTab({ admin, side: 'test', customer }))
    expect(screen.getByText('Showing the newest 1 of 250.')).toBeInTheDocument()
  })

  it('lists the certificates from the masked view, each linked to its page', async () => {
    const admin = await principal({ role: 'operator' })
    fakeService(() => ({
      data: [
        {
          id: ids.line,
          common_name: 'shop.ng',
          product_name: 'PositiveSSL',
          status: 'issued',
          issued_at: '2026-10-02T09:00:00Z',
          expires_at: '2027-04-20T09:00:00Z',
          created_at: '2026-10-01T09:00:00Z',
          test_mode: false,
        },
        {
          id: ids.line2,
          common_name: '*.blog.ng',
          product_name: null,
          status: 'awaiting_setup',
          issued_at: null,
          expires_at: null,
          created_at: '2026-10-01T08:00:00Z',
          test_mode: false,
        },
      ],
    }))
    render(await CustomerCertificatesTab({ admin, side: 'live', customer }))
    const table = screen.getByRole('table')
    expect(within(table).getByRole('link', { name: 'shop.ng' })).toHaveAttribute(
      'href',
      `/admin/ssl/${ids.line}`,
    )
    expect(within(table).getByText('PositiveSSL')).toBeInTheDocument()
    // The column and the status share a word: one header, one pill.
    expect(within(table).getAllByText('Issued')).toHaveLength(2)
    expect(within(table).getByText('Waiting for set-up')).toBeInTheDocument()
    expect(within(table).getByText('Not yet')).toBeInTheDocument()
  })

  it('says when there are no certificates, or they could not be read', async () => {
    const admin = await principal({ role: 'operator' })
    fakeService(() => ({ data: [] }))
    const { unmount } = render(await CustomerCertificatesTab({ admin, side: 'live', customer }))
    expect(
      screen.getByText('No certificates for this customer on the Live side.'),
    ).toBeInTheDocument()
    unmount()
    fakeService(() => ({ error: { message: 'boom' } }))
    render(await CustomerCertificatesTab({ admin, side: 'live', customer }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This part of the customer couldn’t be loaded.',
    )
    fakeService(() => ({ error: { message: 'boom' } }))
    const domains = render(await CustomerDomainsTab({ admin, side: 'live', customer }))
    expect(within(domains.container).getByRole('alert')).toBeInTheDocument()
  })

  it('shows the newest emails and links to all of them by the account’s id, never its address', async () => {
    const admin = await principal({ role: 'operator' })
    fakeService(() => ({
      data: [
        {
          id: ids.key,
          kind: 'order_receipt',
          category: 'transactional',
          status: 'sent',
          delivery_status: 'bounced',
          created_at: '2026-10-02T09:00:00Z',
          sent_at: '2026-10-02T09:01:00Z',
          test_mode: false,
        },
      ],
      count: 12,
    }))
    render(await CustomerEmailsTab({ admin, side: 'live', customer }))
    expect(screen.getByRole('heading', { level: 2, name: 'Emails · 12' })).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(within(table).getByText('Order receipt')).toBeInTheDocument()
    expect(within(table).getByText('Bounced')).toBeInTheDocument()
    const all = screen.getByRole('link', { name: 'All of this customer’s emails' })
    expect(all).toHaveAttribute('href', `/admin/emails?user=${ids.user}`)
    expect(all.getAttribute('href')).not.toContain('@')
  })

  it('says when no email was queued, with no link to an empty list', async () => {
    const admin = await principal({ role: 'operator' })
    fakeService(() => ({ data: [], count: 0 }))
    render(await CustomerEmailsTab({ admin, side: 'test', customer }))
    expect(
      screen.getByText('No emails queued for this customer on the Test side.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'All of this customer’s emails' })).toBeNull()
  })
})
