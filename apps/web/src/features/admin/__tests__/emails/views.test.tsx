import { render, screen, within } from '@testing-library/react'
import { cloneElement, isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComplianceTab } from '@/features/admin/components/emails/compliance-tab'
import { EmailsSkeleton, EmailsView } from '@/features/admin/components/emails/emails-view'
import { OutboxTab } from '@/features/admin/components/emails/outbox-tab'
import {
  type NoticeParams,
  type OutboxParams,
  parseEmailsParams,
} from '@/features/admin/lib/emails-params'
import {
  type EmailStats,
  getEmailStats,
  listNotices,
  listOutbox,
} from '@/features/admin/queries/emails'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { NOW, noticeRow, outboxRow } from './fake-db'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/admin/emails',
}))
vi.mock('@/features/admin/components/shell/side-switch', () => ({
  SideSwitch: ({ side }: { side: string }) => <p>Side: {side}</p>,
}))
vi.mock('@/features/admin/actions/emails', () => ({ requeueEmail: vi.fn() }))
vi.mock('@/features/admin/queries/session', () => ({
  requireAdmin: vi.fn(),
  getAdminSide: vi.fn(),
}))
vi.mock('@/features/admin/queries/emails', () => ({
  getEmailStats: vi.fn(),
  listOutbox: vi.fn(),
  listNotices: vi.fn(),
}))

/**
 * /admin/emails as an admin sees it (ADMIN-SPEC §5.2 B11): the page opens
 * on the filter it was linked with (§9: ?status=failed), each tab's figures
 * and list in their four states, the Test-side note, and the compliance tab
 * with nothing to press but links.
 */

/** Renders server components: awaits each async one in the tree. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolve(child)))
  if (!isValidElement(node)) return node
  const { type, props } = node as { type: unknown; props: { children?: ReactNode } }
  if (typeof type === 'function' && type.constructor.name === 'AsyncFunction') {
    return resolve(await (type as (p: unknown) => Promise<ReactNode>)(props))
  }
  if (props.children === undefined) return node
  const children = await resolve(props.children)
  return Array.isArray(children)
    ? cloneElement(node, undefined, ...children)
    : cloneElement(node, undefined, children)
}

const operator = { label: 'e2e-1', role: 'operator', testOnly: true } as unknown as AdminPrincipal
const stats: EmailStats = {
  days: 30,
  byKind: [
    {
      kind: 'order_receipt',
      category: 'transactional',
      status: 'failed',
      deliveryStatus: null,
      count: 1,
    },
  ],
  notices: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue(operator)
  vi.mocked(getAdminSide).mockResolvedValue('test')
  vi.mocked(getEmailStats).mockResolvedValue(stats)
  vi.mocked(listOutbox).mockResolvedValue({ ok: true, rows: [outboxRow()], total: 1 })
  vi.mocked(listNotices).mockResolvedValue({ ok: true, rows: [noticeRow()], total: 1 })
})

describe('EmailsView', () => {
  it('opens the failed emails for ?status=failed, on the admin’s side', async () => {
    render(await resolve(await EmailsView({ searchParams: Promise.resolve({ status: 'failed' }) })))
    expect(screen.getByRole('heading', { level: 1, name: 'Emails' })).toBeInTheDocument()
    expect(screen.getByText('Side: test')).toBeInTheDocument()
    expect(
      within(screen.getByRole('navigation', { name: 'Email views' })).getByRole('link', {
        name: 'Outbox',
      }),
    ).toHaveAttribute('aria-current', 'page')
    expect(listOutbox).toHaveBeenCalledWith(
      operator,
      'test',
      expect.objectContaining({ tab: 'outbox', status: 'failed' }),
      expect.any(Date),
    )
    const status = screen.getByRole('navigation', { name: 'Status' })
    expect(within(status).getByRole('link', { name: 'Failed' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(screen.getByRole('heading', { name: '1 email' })).toBeInTheDocument()
    expect(listNotices).not.toHaveBeenCalled()
  })

  it('opens the compliance notices for ?tab=compliance', async () => {
    render(
      await resolve(await EmailsView({ searchParams: Promise.resolve({ tab: 'compliance' }) })),
    )
    expect(
      within(screen.getByRole('navigation', { name: 'Email views' })).getByRole('link', {
        name: 'Compliance notices',
      }),
    ).toHaveAttribute('aria-current', 'page')
    expect(listNotices).toHaveBeenCalledWith(
      operator,
      'test',
      expect.objectContaining({ tab: 'compliance' }),
    )
    expect(listOutbox).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: '1 notice' })).toBeInTheDocument()
  })

  it('has a loading state of pulsing blocks, not a spinner', () => {
    const { container } = render(<EmailsSkeleton />)
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })
})

describe('OutboxTab', () => {
  const params = (search: Record<string, string> = {}) => parseEmailsParams(search) as OutboxParams

  it('notes the Test side, shows the figures, the filters, the list and the kinds', async () => {
    render(await OutboxTab({ admin: operator, side: 'test', params: params(), now: NOW }))
    expect(screen.getByTestId('emails-test-side-note')).toHaveTextContent(
      'On the Test side most emails show as Skipped',
    )
    expect(screen.getByRole('heading', { name: 'Last 30 days' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Find emails' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'By kind, last 30 days' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Send again/ }).length).toBeGreaterThan(0)
  })

  it('keeps the list when the figures fail, and the figures when the list fails', async () => {
    vi.mocked(getEmailStats).mockResolvedValue(null)
    const first = render(
      await OutboxTab({ admin: operator, side: 'live', params: params(), now: NOW }),
    )
    expect(screen.getByText("The email figures couldn't be loaded.")).toBeInTheDocument()
    expect(screen.queryByTestId('emails-test-side-note')).toBeNull()
    expect(screen.getByRole('heading', { name: '1 email' })).toBeInTheDocument()
    first.unmount()

    vi.mocked(getEmailStats).mockResolvedValue(stats)
    vi.mocked(listOutbox).mockRejectedValue(new Error('fetch failed'))
    render(await OutboxTab({ admin: operator, side: 'live', params: params(), now: NOW }))
    expect(screen.getByText("The emails couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Emails' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Last 30 days' })).toBeInTheDocument()
  })

  it('survives figures that throw', async () => {
    vi.mocked(getEmailStats).mockRejectedValue(new Error('fetch failed'))
    render(await OutboxTab({ admin: operator, side: 'test', params: params(), now: NOW }))
    expect(screen.getByText("The email figures couldn't be loaded.")).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /By kind/ })).toBeNull()
  })
})

describe('ComplianceTab', () => {
  const params = (search: Record<string, string> = {}) =>
    parseEmailsParams({ tab: 'compliance', ...search }) as NoticeParams

  it('says the notices are compliance records, and offers no action at all', async () => {
    render(await ComplianceTab({ admin: operator, side: 'test', params: params() }))
    expect(screen.getByTestId('emails-compliance-note')).toHaveTextContent(
      'Nothing on this page changes, deletes or sends them.',
    )
    expect(screen.getByRole('heading', { name: 'Notices sent, last 30 days' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Find notices' })).toBeInTheDocument()
    // Only the dates form submits, and it only filters the list (GET).
    const buttons = screen.queryAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['Apply dates'])
    for (const form of document.querySelectorAll('form')) {
      expect(form.getAttribute('method')).toBe('get')
    }
  })

  it('shows each failure in words', async () => {
    vi.mocked(getEmailStats).mockRejectedValue(new Error('fetch failed'))
    vi.mocked(listNotices).mockRejectedValue(new Error('fetch failed'))
    render(await ComplianceTab({ admin: operator, side: 'live', params: params() }))
    expect(screen.getByText("The email figures couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByText("The compliance notices couldn't be loaded.")).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Notices' })).toBeInTheDocument()
  })
})
