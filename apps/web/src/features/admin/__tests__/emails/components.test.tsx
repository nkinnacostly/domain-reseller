import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requeueEmail } from '@/features/admin/actions/emails'
import { NoticeList, noticeColumns } from '@/features/admin/components/emails/compliance-tab'
import {
  NoticeFilters,
  OutboxFilters,
  SortLinks,
} from '@/features/admin/components/emails/email-filters'
import { EmailTabs, RelatedLinks, When } from '@/features/admin/components/emails/email-parts'
import {
  KindTable,
  NoticeFigures,
  OutboxFigures,
} from '@/features/admin/components/emails/email-stats'
import { OutboxList } from '@/features/admin/components/emails/outbox-tab'
import { SendAgain } from '@/features/admin/components/emails/send-again'
import {
  type NoticeParams,
  type OutboxParams,
  parseEmailsParams,
} from '@/features/admin/lib/emails-params'
import type { EmailStats } from '@/features/admin/queries/emails'
import { ids, NOW, noticeRow, outboxRow } from './fake-db'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/admin/emails',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/features/admin/actions/emails', () => ({ requeueEmail: vi.fn() }))

/**
 * The emails page's parts (ADMIN-SPEC §5.2 B11): recipients only masked,
 * "Send again" only on a failed email that neither bounced nor was reported
 * as spam, the compliance list with no control of any kind, every list's
 * four states, and links that keep the URL the source of truth.
 */

const outbox = (search: Record<string, string> = {}) => parseEmailsParams(search) as OutboxParams
const notices = (search: Record<string, string> = {}) =>
  parseEmailsParams({ tab: 'compliance', ...search }) as NoticeParams

const operator = { role: 'operator' as const, testOnly: true }
const viewer = { role: 'viewer' as const, testOnly: false }

beforeEach(() => vi.clearAllMocks())

describe('EmailTabs', () => {
  it('marks the open view with aria-current and a tick, and links each by its address', () => {
    render(<EmailTabs current="compliance" />)
    const nav = screen.getByRole('navigation', { name: 'Email views' })
    const open = within(nav).getByRole('link', { name: 'Compliance notices' })
    expect(open).toHaveAttribute('aria-current', 'page')
    expect(open).toHaveAttribute('href', '/admin/emails?tab=compliance')
    const other = within(nav).getByRole('link', { name: 'Outbox' })
    expect(other).not.toHaveAttribute('aria-current')
    expect(other).toHaveAttribute('href', '/admin/emails')
  })
})

describe('OutboxList', () => {
  const list = (rows = [outboxRow()], total = rows.length) => ({ ok: true as const, rows, total })

  it('shows the recipient masked, never an address, and offers Send again on a failed email', () => {
    render(<OutboxList admin={operator} side="test" params={outbox()} list={list()} now={NOW} />)
    expect(screen.getAllByText('e•••@example.com').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/e2e-[^@\s]*@example\.com/)
    expect(screen.getAllByText('e2e: a seeded failure for [address]').length).toBeGreaterThan(0)
    const buttons = screen.getAllByRole('button', {
      name: `Send again the Order receipt email ${ids.email.replace(/-/g, '').slice(0, 8)}`,
    })
    expect(buttons.length).toBeGreaterThan(0)
    // Related records are linked by id, the order by its number.
    expect(screen.getAllByRole('link', { name: 'ND-001234' })[0]).toHaveAttribute(
      'href',
      `/admin/orders/${ids.order}`,
    )
    expect(screen.getAllByRole('link', { name: /^Account / })[0]).toHaveAttribute(
      'href',
      `/admin/customers/${ids.user}`,
    )
  })

  it('never offers Send again for a bounce or a spam report, and says why', () => {
    render(
      <OutboxList
        admin={operator}
        side="test"
        params={outbox()}
        list={list([
          outboxRow({ id: ids.email, deliveryStatus: 'bounced' }),
          outboxRow({ id: ids.other, complainedAt: '2026-10-03T10:00:00Z' }),
        ])}
        now={NOW}
      />,
    )
    expect(screen.queryByRole('button', { name: /Send again/ })).toBeNull()
    expect(screen.getAllByText('Bounced: never sent again.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Reported as spam: never sent again.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Reported as spam').length).toBeGreaterThan(0)
  })

  it('offers a viewer no button, and says who can', () => {
    render(<OutboxList admin={viewer} side="live" params={outbox()} list={list()} now={NOW} />)
    expect(screen.queryByRole('button', { name: /Send again/ })).toBeNull()
    expect(
      screen.getAllByText('An operator or the owner can send it again.').length,
    ).toBeGreaterThan(0)
  })

  it('words what became of each email: delivered, no report, skipped, waiting', () => {
    render(
      <OutboxList
        admin={operator}
        side="test"
        params={outbox()}
        list={list([
          outboxRow({
            id: '10000000-0000-4000-8000-000000000001',
            status: 'sent',
            deliveryStatus: 'delivered',
            sentAt: '2026-10-03T09:01:00Z',
            templateVersion: 'order_receipt@3',
            lastErrorSafe: null,
          }),
          outboxRow({
            id: '10000000-0000-4000-8000-000000000002',
            kind: 'new_sign_in',
            category: 'security',
            status: 'sent',
            sentAt: '2026-10-01T09:00:00Z',
            lastErrorSafe: null,
          }),
          outboxRow({
            id: '10000000-0000-4000-8000-000000000003',
            status: 'skipped',
            skipReason: 'reserved_address',
            lastErrorSafe: null,
            orderId: null,
            userId: null,
          }),
          outboxRow({ id: '10000000-0000-4000-8000-000000000004', status: 'pending' }),
        ])}
        now={NOW}
      />,
    )
    expect(screen.getAllByText('Delivered').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No delivery report').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText('A reserved address (example.com, .test …): never sent to').length,
    ).toBeGreaterThan(0)
    expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Next try').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/template order_receipt@3/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Send again/ })).toBeNull()
  })

  it('has an error state with Try again', () => {
    render(<OutboxList admin={operator} side="test" params={outbox()} list={null} now={NOW} />)
    expect(screen.getByRole('alert')).toHaveTextContent("The emails couldn't be loaded.")
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('has an empty state for the side, and another for filters with a way back', () => {
    const { unmount } = render(
      <OutboxList admin={operator} side="test" params={outbox()} list={list([])} now={NOW} />,
    )
    expect(screen.getByText('No emails on the Test side yet')).toBeInTheDocument()
    unmount()
    render(
      <OutboxList
        admin={operator}
        side="live"
        params={outbox({ status: 'failed' })}
        list={list([])}
        now={NOW}
      />,
    )
    expect(screen.getByText('No emails match these filters')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show every email' })).toHaveAttribute(
      'href',
      '/admin/emails',
    )
  })

  it('says so when the page is past the end, and offers the first page', () => {
    render(
      <OutboxList
        admin={operator}
        side="test"
        params={outbox({ status: 'failed', page: '9' })}
        list={list([], 30)}
        now={NOW}
      />,
    )
    expect(screen.getByText('Nothing on page 9.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/emails?status=failed',
    )
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
  })

  it('sorts from the column headers, with aria-sort, and pages through the list', () => {
    render(
      <OutboxList
        admin={operator}
        side="test"
        params={outbox({ status: 'failed' })}
        list={list([outboxRow()], 60)}
        now={NOW}
      />,
    )
    const table = screen.getByRole('table', { name: /Emails on the Test side, page 1 of 3/ })
    const queued = within(table).getByRole('columnheader', { name: /Queued/ })
    expect(queued).toHaveAttribute('aria-sort', 'descending')
    expect(within(queued).getByRole('link')).toHaveAttribute(
      'href',
      '/admin/emails?status=failed&dir=asc',
    )
    expect(screen.getByRole('link', { name: /Next/ })).toHaveAttribute(
      'href',
      '/admin/emails?status=failed&page=2',
    )
  })
})

describe('SendAgain', () => {
  function setup() {
    const user = userEvent.setup()
    render(
      <SendAgain
        emailId={ids.email}
        kind="Order receipt"
        reference="0e1e2f3a"
        maskedTo="e•••@example.com"
        attempts={3}
        lastErrorSafe="e2e: a seeded failure for [address]"
        returnTo="/admin/emails?status=failed"
      />,
    )
    return user
  }

  it('shows what will be sent again, masked, and asks the action with a request key', async () => {
    vi.mocked(requeueEmail).mockResolvedValue({ data: { ok: true, auditId: 9 } } as never)
    const user = setup()
    await user.click(
      screen.getByRole('button', { name: 'Send again the Order receipt email 0e1e2f3a' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Send this email again?' })
    expect(within(dialog).getByText('e•••@example.com')).toBeInTheDocument()
    expect(within(dialog).getByText('3 tries')).toBeInTheDocument()
    expect(within(dialog).getByText('e2e: a seeded failure for [address]')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Reason (optional)')).toBeInTheDocument()
    // A standard action: no code is asked for.
    expect(within(dialog).queryByLabelText('Code from your authenticator app')).toBeNull()

    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Provider was down')
    await user.click(within(dialog).getByRole('button', { name: 'Send again' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(requeueEmail).toHaveBeenCalledWith({
      emailId: ids.email,
      reason: 'Provider was down',
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(toast.success).toHaveBeenCalledWith(
      'Queued to send again. It shows as Waiting until the sender takes it.',
    )
  })

  it('shows a refusal in words and stays open', async () => {
    vi.mocked(requeueEmail).mockResolvedValue({
      data: {
        ok: false,
        code: 'BOUNCED',
        message: 'This email bounced. It is not sent again.',
        auditId: 3,
      },
    } as never)
    const user = setup()
    await user.click(screen.getByRole('button', { name: /Send again/ }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Send again' }))
    expect(
      await within(dialog).findByText('This email bounced. It is not sent again.'),
    ).toBeVisible()
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('NoticeList', () => {
  const list = (rows = [noticeRow()], total = rows.length) => ({ ok: true as const, rows, total })

  it('lists notices read only: masked recipient, the window, delivery — and no control', () => {
    render(
      <NoticeList
        side="test"
        params={notices()}
        list={list([
          noticeRow(),
          noticeRow({
            id: '20000000-0000-4000-8000-000000000001',
            noticeType: 'errp_post',
            deliveryStatus: 'bounced',
            domainId: null,
            domainName: 'gone.com',
            checkedAt: null,
          }),
          noticeRow({
            id: '20000000-0000-4000-8000-000000000002',
            deliveryStatus: 'sent',
            userId: null,
          }),
        ])}
      />,
    )
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(document.querySelector('form')).toBeNull()
    expect(screen.getAllByText('a•••@gmail.com').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Sent 26–35 days before expiry').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Bounced').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No report yet').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Not yet').length).toBeGreaterThan(0)
    // A domain we still hold links by id; one gone is its name alone.
    expect(screen.getAllByRole('link', { name: 'expiring.com' })[0]).toHaveAttribute(
      'href',
      `/admin/domains/${ids.domain}`,
    )
    expect(screen.queryByRole('link', { name: 'gone.com' })).toBeNull()
    expect(screen.getAllByText('gone.com').length).toBeGreaterThan(0)
  })

  it('has error, empty, filtered and past-the-end states', () => {
    const { unmount } = render(<NoticeList side="live" params={notices()} list={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      "The compliance notices couldn't be loaded.",
    )
    unmount()

    const second = render(<NoticeList side="live" params={notices()} list={list([])} />)
    expect(screen.getByText('No expiry notices sent on the Live side yet')).toBeInTheDocument()
    second.unmount()

    const third = render(
      <NoticeList side="live" params={notices({ status: 'bounced' })} list={list([])} />,
    )
    expect(screen.getByRole('link', { name: 'Show every notice' })).toHaveAttribute(
      'href',
      '/admin/emails?tab=compliance',
    )
    third.unmount()

    render(<NoticeList side="live" params={notices({ page: '4' })} list={list([], 3)} />)
    expect(screen.getByRole('link', { name: 'Go to the first page' })).toHaveAttribute(
      'href',
      '/admin/emails?tab=compliance',
    )
  })

  it('sorts by sent or by the domain’s expiry', () => {
    expect(noticeColumns().flatMap((column) => (column.sort ? [column.sort] : []))).toEqual([
      'expires',
      'sent',
    ])
  })
})

describe('filters', () => {
  it('links each status chip, one at a time, keeping the other filters', () => {
    render(<OutboxFilters params={outbox({ status: 'failed', category: 'security' })} />)
    const status = screen.getByRole('navigation', { name: 'Status' })
    const failed = within(status).getByRole('link', { name: 'Failed' })
    expect(failed).toHaveAttribute('aria-current', 'true')
    // Choosing the chosen chip again shows them all.
    expect(failed).toHaveAttribute('href', '/admin/emails?category=security')
    expect(within(status).getByRole('link', { name: 'Bounced' })).toHaveAttribute(
      'href',
      '/admin/emails?status=bounced&category=security',
    )
    expect(within(status).getByRole('link', { name: 'All' })).toHaveAttribute(
      'href',
      '/admin/emails?category=security',
    )
    const category = screen.getByRole('navigation', { name: 'Category' })
    expect(within(category).getByRole('link', { name: 'Compliance' })).toHaveAttribute(
      'href',
      '/admin/emails?status=failed&category=compliance',
    )
  })

  it('explains a status that is not a plain one', () => {
    render(<OutboxFilters params={outbox({ status: 'unconfirmed' })} />)
    expect(screen.getByTestId('emails-status-hint')).toHaveTextContent(
      'Security and compliance emails sent over 24 hours ago with no delivery report.',
    )
  })

  it('shows a chosen kind with a way back, and keeps the list in the dates form', () => {
    render(<OutboxFilters params={outbox({ kind: 'refund_sent', status: 'sent', page: '2' })} />)
    expect(screen.getByText('Refund sent')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show every kind' })).toHaveAttribute(
      'href',
      '/admin/emails?status=sent',
    )
    const form = screen.getByRole('form', { name: 'Queued between dates' })
    const hidden = [...form.querySelectorAll('input[type="hidden"]')].map((input) => [
      input.getAttribute('name'),
      input.getAttribute('value'),
    ])
    expect(hidden).toEqual([
      ['status', 'sent'],
      ['kind', 'refund_sent'],
    ])
    expect(screen.getByLabelText('Queued from')).toHaveAttribute('type', 'date')
  })

  it('offers clearing dates only when there are some', () => {
    const { unmount } = render(<OutboxFilters params={outbox()} />)
    expect(screen.queryByRole('link', { name: 'Clear dates' })).toBeNull()
    unmount()
    render(<NoticeFilters params={notices({ from: '2026-10-01', type: 'errp_pre_7' })} />)
    expect(screen.getByRole('link', { name: 'Clear dates' })).toHaveAttribute(
      'href',
      '/admin/emails?tab=compliance&type=errp_pre_7',
    )
    const form = screen.getByRole('form', { name: 'Sent between dates' })
    expect(form.querySelector('input[name="tab"]')).toHaveAttribute('value', 'compliance')
    const delivery = screen.getByRole('navigation', { name: 'Delivery' })
    expect(within(delivery).getByRole('link', { name: 'Bounced' })).toHaveAttribute(
      'href',
      '/admin/emails?tab=compliance&status=bounced&type=errp_pre_7&from=2026-10-01',
    )
    const notice = screen.getByRole('navigation', { name: 'Notice' })
    expect(within(notice).getByRole('link', { name: 'One week before expiry' })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('sorts below xl with words and a tick for the current sort', () => {
    render(
      <SortLinks
        label="Sort emails"
        params={outbox({ sort: 'sent' })}
        sorts={[
          { value: 'created', label: 'Queued' },
          { value: 'sent', label: 'Sent' },
        ]}
      />,
    )
    const nav = screen.getByRole('navigation', { name: 'Sort emails' })
    const sent = within(nav).getByRole('link', { name: /^Sent/ })
    expect(sent).toHaveAttribute('aria-current', 'true')
    expect(sent).toHaveAttribute('href', '/admin/emails?sort=sent&dir=asc')
    expect(within(nav).getByRole('link', { name: /^Queued/ })).toHaveAttribute(
      'href',
      '/admin/emails',
    )
  })
})

describe('figures', () => {
  const stats: EmailStats = {
    days: 30,
    byKind: [
      {
        kind: 'order_receipt',
        category: 'transactional',
        status: 'failed',
        deliveryStatus: null,
        count: 2,
      },
      {
        kind: 'order_receipt',
        category: 'transactional',
        status: 'sent',
        deliveryStatus: 'bounced',
        count: 1,
      },
      {
        kind: 'new_sign_in',
        category: 'security',
        status: 'skipped',
        deliveryStatus: null,
        count: 4,
      },
    ],
    notices: [{ noticeType: 'errp_post', deliveryStatus: 'bounced', count: 1 }],
  }

  it('links each outbox figure to its list, the count inside the link’s name', () => {
    render(<OutboxFigures stats={stats} params={outbox({ kind: 'x_y', page: '3' })} />)
    expect(screen.getByRole('link', { name: /Failed\s+2/ })).toHaveAttribute(
      'href',
      '/admin/emails?status=failed',
    )
    expect(screen.getByRole('link', { name: /Bounced\s+1/ })).toHaveAttribute(
      'href',
      '/admin/emails?status=bounced',
    )
    expect(screen.getByRole('link', { name: /Skipped\s+4/ })).toBeInTheDocument()
  })

  it('lists kinds, each linking to its emails', () => {
    render(<KindTable stats={stats} params={outbox({ status: 'failed' })} />)
    expect(screen.getAllByRole('link', { name: 'New sign-in' })[0]).toHaveAttribute(
      'href',
      '/admin/emails?kind=new_sign_in',
    )
    expect(screen.getByRole('table', { name: 'Emails by kind, last 30 days' })).toBeInTheDocument()
  })

  it('says when no kind was queued', () => {
    render(<KindTable stats={{ ...stats, byKind: [] }} params={outbox()} />)
    expect(screen.getByText('No emails were queued in that time.')).toBeInTheDocument()
  })

  it('counts each notice type by delivery', () => {
    render(<NoticeFigures stats={stats} />)
    expect(screen.getByText('After expiry')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Sent within 5 days after expiry. 0 delivered · 1 bounced · 0 no report yet',
      ),
    ).toBeInTheDocument()
  })
})

describe('small parts', () => {
  it('writes a time in WAT, or a word for none', () => {
    const { container } = render(<When at="2026-10-03T13:05:00Z" />)
    expect(container).toHaveTextContent('3 Oct 2026 14:05 WAT')
    render(<When at={null} none="Not sent" />)
    expect(screen.getByText('Not sent')).toBeInTheDocument()
  })

  it('links what an email was for by id, or shows a dash', () => {
    const { container } = render(<RelatedLinks />)
    expect(container).toHaveTextContent('—')
    render(<RelatedLinks orderId={ids.order} domainId={ids.domain} />)
    expect(screen.getByRole('link', { name: 'Order' })).toHaveAttribute(
      'href',
      `/admin/orders/${ids.order}`,
    )
    expect(screen.getByRole('link', { name: 'Domain' })).toHaveAttribute(
      'href',
      `/admin/domains/${ids.domain}`,
    )
  })
})
