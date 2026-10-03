import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Activity } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findCustomers, revealCustomer } from '@/features/admin/actions/customers'
import { CustomerSearch } from '@/features/admin/components/customers/customer-search'
import { CustomerStatsPanel } from '@/features/admin/components/customers/customer-stats'
import {
  CustomerFilters,
  CustomerSortLinks,
  CustomersList,
} from '@/features/admin/components/customers/customers-list'
import { RevealContact } from '@/features/admin/components/customers/reveal-contact'
import { toCustomerRow } from '@/features/admin/lib/customers-data'
import { parseCustomerListParams } from '@/features/admin/lib/customers-params'
import { SERVER_CRASH_WORDS } from '@/features/admin/lib/errors'
import { customerRow, ids } from './fake-db'

/**
 * The customers pages' controls (ADMIN-SPEC §5.2 B8): the search posts its
 * query and never names a field a page load could send; a reveal asks first,
 * shows the details only here, asks again after a replayed key, and both
 * forget what they held when the page is left.
 */

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/customers', () => ({
  findCustomers: vi.fn(),
  revealCustomer: vi.fn(),
}))

const EMAIL = 'ada@example.ng'
const UUID = /^[0-9a-f-]{36}$/

const found = {
  userId: ids.user,
  maskedEmail: 'a•••@example.ng',
  joinedAt: '2026-09-01T10:00:00Z',
  domainsHeld: 2,
  ordersPaid: 1,
}

beforeEach(() => vi.clearAllMocks())

describe('CustomerSearch', () => {
  it('tells a role that cannot search so, with no form', () => {
    render(<CustomerSearch testOnly={false} canSearch={false} />)
    expect(
      screen.getByText('Your admin role can’t look customers up. Ask the owner.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('is a POST form whose box has no name, ready once the page runs', () => {
    const { container } = render(<CustomerSearch testOnly={false} canSearch />)
    const form = container.querySelector('form')
    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveAttribute('data-enhanced', 'true')
    expect(form).not.toHaveAttribute('action')
    const box = screen.getByRole('searchbox', { name: 'Email, order number or domain' })
    expect(box).not.toHaveAttribute('name')
    expect(box).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled()
    expect(screen.getByText(/never in the page address/)).toBeInTheDocument()
  })

  it('asks for 3 characters before sending anything', async () => {
    const { container } = render(<CustomerSearch testOnly={false} canSearch />)
    await userEvent.type(screen.getByRole('searchbox'), 'ab')
    fireEvent.submit(container.querySelector('form') as HTMLFormElement)
    expect(await screen.findByText('Type at least 3 characters.')).toBeInTheDocument()
    expect(findCustomers).not.toHaveBeenCalled()
  })

  it('sends the query and lists the masked matches, each linked by id', async () => {
    vi.mocked(findCustomers).mockResolvedValue({
      data: { ok: true, auditId: 3, data: [found] },
    } as never)
    const user = userEvent.setup()
    render(<CustomerSearch testOnly canSearch />)
    expect(
      screen.getByText(/Test administrators find e2e test accounts only\./),
    ).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox'), ` ${EMAIL} `)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(findCustomers).toHaveBeenCalledWith({ query: EMAIL })
    expect(await screen.findByText('1 customer matches exactly.')).toBeInTheDocument()
    expect(screen.getByText('Domains and orders on the Test side.')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Customers found' })
    expect(within(list).getByRole('link', { name: 'Account 2a2b2c2d' })).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}`,
    )
    expect(within(list).getByText('a•••@example.ng')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.queryByText('1 customer matches exactly.')).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox')).toHaveValue('')
  })

  it('says when nothing matches exactly', async () => {
    vi.mocked(findCustomers).mockResolvedValue({
      data: { ok: true, auditId: 3, data: [] },
    } as never)
    const user = userEvent.setup()
    render(<CustomerSearch testOnly={false} canSearch />)
    await user.type(screen.getByRole('searchbox'), 'ND-001035')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('No customer matches that exactly.')).toBeInTheDocument()
  })

  it('shows a refusal in its words, and a lost answer as a search that did not finish', async () => {
    vi.mocked(findCustomers).mockResolvedValueOnce({
      data: {
        ok: false,
        code: 'RATE_LIMITED',
        message: "You've looked up a lot of customers this hour. Wait, or ask the owner.",
      },
    } as never)
    vi.mocked(findCustomers).mockResolvedValueOnce({ serverError: SERVER_CRASH_WORDS } as never)
    vi.mocked(findCustomers).mockRejectedValueOnce(new Error('network'))
    const user = userEvent.setup()
    render(<CustomerSearch testOnly={false} canSearch />)
    await user.type(screen.getByRole('searchbox'), EMAIL)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You've looked up a lot of customers this hour.",
    )
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The search didn’t finish. Try again in a moment.',
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(findCustomers).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('alert')).toHaveTextContent('The search didn’t finish.')
  })

  it('forgets the query and the matches when the page is left, though the router keeps it', async () => {
    vi.mocked(findCustomers).mockResolvedValue({
      data: { ok: true, auditId: 3, data: [found] },
    } as never)
    const user = userEvent.setup()
    const page = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <CustomerSearch testOnly={false} canSearch />
      </Activity>
    )
    const { rerender } = render(page('visible'))
    await user.type(screen.getByRole('searchbox'), EMAIL)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('1 customer matches exactly.')).toBeInTheDocument()
    rerender(page('hidden'))
    rerender(page('visible'))
    await waitFor(() =>
      expect(screen.queryByText('1 customer matches exactly.')).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('searchbox')).toHaveValue('')
  })
})

describe('RevealContact', () => {
  const contact = {
    email: EMAIL,
    fullName: 'Ada Obi',
    phone: '+2348012345678',
    businessName: null,
  }

  it('tells a role that cannot reveal so, with no button', () => {
    render(<RevealContact userId={ids.user} canReveal={false} />)
    expect(
      screen.getByText('Your admin role can’t see contact details. Ask the owner.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('asks first, then shows the details here alone, and hides them on request', async () => {
    vi.mocked(revealCustomer).mockResolvedValue({
      data: { ok: true, auditId: 9, data: contact },
    } as never)
    const user = userEvent.setup()
    render(<RevealContact userId={ids.user} canReveal />)
    expect(screen.getByText(/Hidden until you ask\./)).toBeInTheDocument()
    expect(screen.queryByText(EMAIL)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show contact details' }))
    const dialog = screen.getByRole('dialog', { name: 'Show this customer’s contact details?' })
    expect(dialog).toHaveTextContent('Your view is recorded in the audit log.')
    expect(within(dialog).getByLabelText('Reason (optional)')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Show contact details' }))

    expect(revealCustomer).toHaveBeenCalledWith({
      userId: ids.user,
      reason: undefined,
      requestKey: expect.stringMatching(UUID),
    })
    expect(await screen.findByText(EMAIL)).toBeInTheDocument()
    expect(screen.getByText('Ada Obi')).toBeInTheDocument()
    expect(screen.getByText('+2348012345678')).toBeInTheDocument()
    expect(screen.getByText('Not given')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Contact details' })).toHaveFocus(),
    )

    await user.click(screen.getByRole('button', { name: 'Hide contact details' }))
    expect(screen.queryByText(EMAIL)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show contact details' })).toBeInTheDocument()
  })

  it('passes the reason typed, trimmed', async () => {
    vi.mocked(revealCustomer).mockResolvedValue({
      data: { ok: true, auditId: 9, data: contact },
    } as never)
    const user = userEvent.setup()
    render(<RevealContact userId={ids.user} canReveal />)
    await user.click(screen.getByRole('button', { name: 'Show contact details' }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByLabelText('Reason (optional)'), ' Customer rang us ')
    await user.click(within(dialog).getByRole('button', { name: 'Show contact details' }))
    expect(revealCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Customer rang us' }),
    )
  })

  it('asks again with a new key after a replayed answer, which carries no details (D4)', async () => {
    vi.mocked(revealCustomer).mockResolvedValueOnce({
      data: { ok: true, auditId: 9, replayed: true },
    } as never)
    vi.mocked(revealCustomer).mockResolvedValueOnce({
      data: { ok: true, auditId: 10, data: contact },
    } as never)
    const user = userEvent.setup()
    render(<RevealContact userId={ids.user} canReveal />)
    await user.click(screen.getByRole('button', { name: 'Show contact details' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Show contact details' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That view was recorded, but its details are shown only once.',
    )
    expect(screen.queryByText(EMAIL)).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Show contact details' }))
    expect(await screen.findByText(EMAIL)).toBeInTheDocument()
    const [first, second] = vi.mocked(revealCustomer).mock.calls.map(([input]) => input.requestKey)
    expect(first).toMatch(UUID)
    expect(second).toMatch(UUID)
    expect(second).not.toBe(first)
  })

  it('says why it was refused, and shows nothing', async () => {
    vi.mocked(revealCustomer).mockResolvedValue({
      data: {
        ok: false,
        code: 'TEST_ADMIN',
        message: "Test administrators can't do this on live records.",
      },
    } as never)
    const user = userEvent.setup()
    render(<RevealContact userId={ids.user} canReveal />)
    await user.click(screen.getByRole('button', { name: 'Show contact details' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Show contact details' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Test administrators can't do this on live records.",
    )
  })

  it('says when a view’s details could not be read, so it can be asked again', async () => {
    vi.mocked(revealCustomer).mockResolvedValue({ data: { ok: true, auditId: 9 } } as never)
    const user = userEvent.setup()
    render(<RevealContact userId={ids.user} canReveal />)
    await user.click(screen.getByRole('button', { name: 'Show contact details' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Show contact details' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The view was recorded, but its details couldn’t be read.',
    )
  })

  it('forgets the details when the page is left, though the router keeps it (D4)', async () => {
    vi.mocked(revealCustomer).mockResolvedValue({
      data: { ok: true, auditId: 9, data: contact },
    } as never)
    const user = userEvent.setup()
    const page = (mode: 'visible' | 'hidden') => (
      <Activity mode={mode}>
        <RevealContact userId={ids.user} canReveal />
      </Activity>
    )
    const { rerender } = render(page('visible'))
    await user.click(screen.getByRole('button', { name: 'Show contact details' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Show contact details' }),
    )
    expect(await screen.findByText(EMAIL)).toBeInTheDocument()
    rerender(page('hidden'))
    rerender(page('visible'))
    await waitFor(() => expect(screen.queryByText(EMAIL)).not.toBeInTheDocument())
    expect(document.body).not.toHaveTextContent('Ada Obi')
    expect(screen.getByRole('button', { name: 'Show contact details' })).toBeInTheDocument()
  })
})

describe('CustomerStatsPanel', () => {
  it('tells a test admin the totals are not shown', () => {
    render(<CustomerStatsPanel result={{ kind: 'hidden' }} />)
    const region = screen.getByRole('region', { name: 'Accounts' })
    expect(region).toHaveTextContent('Not shown to test administrators.')
  })

  it('says the totals could not be read, with a way to try again', () => {
    render(<CustomerStatsPanel result={{ kind: 'error' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The account totals couldn’t be loaded.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows each total, flags big holders without two-factor, and charts sign-ups', () => {
    render(
      <CustomerStatsPanel
        result={{
          kind: 'ok',
          stats: {
            profiles: 1204,
            confirmed: 1100,
            liveBuyers: 300,
            mfaUsers: 90,
            holders: 250,
            active30d: 400,
            over10NoMfa: 2,
            signupsByDay: [
              { day: '2026-10-01', count: 3 },
              { day: '2026-10-02', count: 5 },
            ],
          },
        }}
      />,
    )
    const region = screen.getByRole('region', { name: 'Accounts' })
    expect(within(region).getByText('1,204')).toBeInTheDocument()
    expect(within(region).getByText('Bought on the live side')).toBeInTheDocument()
    const flagged = screen.getByText('Over 10 live domains, no two-factor').closest('div')
    expect(flagged).toHaveTextContent('2')
    expect(
      screen.getByRole('img', { name: /Sign-ups by day, last 30 days \(WAT\)/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('2 Oct 2026')
  })

  it('draws no chart when there are no days', () => {
    render(
      <CustomerStatsPanel
        result={{
          kind: 'ok',
          stats: {
            profiles: 0,
            confirmed: 0,
            liveBuyers: 0,
            mfaUsers: 0,
            holders: 0,
            active30d: 0,
            over10NoMfa: 0,
            signupsByDay: [],
          },
        }}
      />,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('CustomersList', () => {
  const params = parseCustomerListParams({})

  it('says the list could not be loaded', () => {
    render(<CustomersList side="live" testOnly={false} params={params} list={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The customers couldn’t be loaded.')
  })

  it('says there are no customers yet — or, to a test admin, no e2e accounts', () => {
    const { rerender } = render(
      <CustomersList side="live" testOnly={false} params={params} list={{ rows: [], total: 0 }} />,
    )
    expect(screen.getByText('No customers yet.')).toBeInTheDocument()
    rerender(<CustomersList side="test" testOnly params={params} list={{ rows: [], total: 0 }} />)
    expect(screen.getByText('No e2e test accounts right now.')).toBeInTheDocument()
  })

  it('offers to clear the filters when they match nothing', () => {
    render(
      <CustomersList
        side="live"
        testOnly={false}
        params={parseCustomerListParams({ twofa: 'on' })}
        list={{ rows: [], total: 0 }}
      />,
    )
    expect(screen.getByText('No customers match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear all filters' })).toHaveAttribute(
      'href',
      '/admin/customers',
    )
  })

  it('says a page past the end is empty, with the way back', () => {
    render(
      <CustomersList
        side="live"
        testOnly={false}
        params={parseCustomerListParams({ page: '9', type: 'business' })}
        list={{ rows: [], total: 0 }}
      />,
    )
    expect(screen.getByText('Nothing on page 9.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/customers?type=business',
    )
  })

  it('lists each account masked, by short id, with its facts in words', () => {
    const rows = [
      toCustomerRow(customerRow()),
      toCustomerRow(
        customerRow({
          user_id: ids.other,
          account_type: 'business',
          masked_email: 'b•••@acme.ng',
          email_confirmed: false,
          has_totp: false,
          last_sign_in_at: null,
          is_admin: true,
        }),
      ),
    ]
    render(
      <CustomersList
        side="test"
        testOnly={false}
        params={parseCustomerListParams({ sort: 'paid' })}
        list={{ rows, total: 60 }}
      />,
    )
    const table = screen.getByRole('table', { name: 'Customers, Test side counts, page 1 of 3' })
    expect(within(table).getByRole('link', { name: 'Account 2a2b2c2d' })).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}`,
    )
    expect(within(table).getByText('b•••@acme.ng')).toBeInTheDocument()
    expect(within(table).getByText('Not confirmed')).toBeInTheDocument()
    expect(within(table).getByText('Business')).toBeInTheDocument()
    expect(within(table).getByText('Never')).toBeInTheDocument()
    expect(within(table).getByText('Admin', { selector: 'th span' })).toBeInTheDocument()
    expect(within(table).getByText('On')).toBeInTheDocument()
    expect(within(table).getByText('Off')).toBeInTheDocument()
    expect(within(table).getAllByText('₦18,700')).toHaveLength(2)
    expect(table.querySelector('th[aria-sort="descending"]')).toHaveTextContent('Total paid')
    expect(screen.getByText('Domains, orders and totals count the Test side.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Next/ })).toHaveAttribute(
      'href',
      '/admin/customers?sort=paid&page=2',
    )
  })
})

describe('CustomerFilters and CustomerSortLinks', () => {
  it('links each filter, the chosen one clearing itself', () => {
    render(<CustomerFilters params={parseCustomerListParams({ twofa: 'off', sort: 'orders' })} />)
    const twofa = screen.getByRole('navigation', { name: 'Two-factor' })
    expect(within(twofa).getByRole('link', { name: '2FA off' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(twofa).getByRole('link', { name: '2FA off' })).toHaveAttribute(
      'href',
      '/admin/customers?sort=orders',
    )
    expect(within(twofa).getByRole('link', { name: '2FA on' })).toHaveAttribute(
      'href',
      '/admin/customers?sort=orders&twofa=on',
    )
    const domains = screen.getByRole('navigation', { name: 'Domains' })
    expect(within(domains).getByRole('link', { name: 'All' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(domains).getByRole('link', { name: 'Holds domains' })).toHaveAttribute(
      'href',
      '/admin/customers?sort=orders&holders=yes&twofa=off',
    )
    const type = screen.getByRole('navigation', { name: 'Account type' })
    expect(within(type).getByRole('link', { name: 'Business' })).toHaveAttribute(
      'href',
      '/admin/customers?sort=orders&twofa=off&type=business',
    )
  })

  it('marks the current sort in words, and links it reversed', () => {
    render(<CustomerSortLinks params={parseCustomerListParams({ sort: 'domains' })} />)
    const nav = screen.getByRole('navigation', { name: 'Sort customers' })
    const current = within(nav).getByRole('link', { name: /^Domains held/ })
    expect(current).toHaveAttribute('aria-current', 'true')
    expect(current).toHaveAccessibleName(/sorted descending; select to reverse/)
    expect(current).toHaveAttribute('href', '/admin/customers?sort=domains&dir=asc')
    expect(within(nav).getByRole('link', { name: /^Joined/ })).toHaveAttribute(
      'href',
      '/admin/customers',
    )
  })
})
