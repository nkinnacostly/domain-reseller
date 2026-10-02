import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AdminGate,
  FACTOR_MISMATCH_WORDS,
  WEAK_SIGN_IN_WORDS,
} from '@/features/admin/components/shell/admin-gate'
import { AdminPlaceholder } from '@/features/admin/components/shell/admin-placeholder'
import { AdminSidebar, AdminSidebarSkeleton } from '@/features/admin/components/shell/admin-sidebar'
import { ADMIN_NAV, ADMIN_NAV_HREFS } from '@/features/admin/components/shell/nav'
import { SideBanner } from '@/features/admin/components/shell/side-banner'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import type { AttentionCounts } from '@/features/admin/queries/attention'

const refresh = vi.fn()
const execute = vi.fn()
let pathname = '/admin/refunds'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => pathname,
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('next-safe-action/hooks', () => ({
  useAction: (_action: unknown, options?: { onSuccess?: () => void }) => ({
    execute: (input: unknown) => {
      execute(input)
      options?.onSuccess?.()
    },
    isPending: false,
    result: {},
  }),
}))
vi.mock('@/features/admin/actions/side', () => ({ switchAdminSide: vi.fn() }))
vi.mock('@/features/auth/actions/session', () => ({ signOut: vi.fn() }))

const session = vi.hoisted(() => ({
  adminSessionStatus: vi.fn(),
  requireAdmin: vi.fn(),
  findAdmin: vi.fn(),
  getAdminSide: vi.fn(),
}))
vi.mock('@/features/admin/queries/session', () => session)
const attention = vi.hoisted(() => ({ getAttentionCounts: vi.fn() }))
vi.mock('@/features/admin/queries/attention', () => attention)
vi.mock('@/features/auth/queries/account', () => ({
  getAccount: async () => ({ fullName: 'Ayang Owner', email: 'owner@example.com' }),
}))

const owner = { label: 'owner', role: 'owner' as const, testOnly: false }
const counts: AttentionCounts = {
  refunds: 2,
  jobs: 1,
  incidents: 1,
  alertsCritical: 0,
  alertsWarning: 4,
  drift: 0,
  stuckOrders: 0,
  pendingWithoutJob: 1,
  emailsFailed: 5,
  ledgerUnexplained: 0,
  presetDrafts: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  session.requireAdmin.mockResolvedValue(owner)
  session.findAdmin.mockResolvedValue(owner)
  session.getAdminSide.mockResolvedValue('live')
  attention.getAttentionCounts.mockResolvedValue(counts)
})

describe('AdminGate', () => {
  it('renders the page for an admin SQL lets in, with the side banner on the test side', async () => {
    session.adminSessionStatus.mockResolvedValue('ok')
    session.getAdminSide.mockResolvedValue('test')
    render(await AdminGate({ children: <p>Refunds page</p> }))
    expect(screen.getByText('Refunds page')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Showing test-mode records — no real money')
  })

  it('explains an authenticator that is not linked', async () => {
    session.adminSessionStatus.mockResolvedValue('factor_mismatch')
    render(await AdminGate({ children: <p>Refunds page</p> }))
    expect(screen.getByText(FACTOR_MISMATCH_WORDS)).toBeInTheDocument()
    expect(screen.queryByText('Refunds page')).toBeNull()
  })

  it('asks for a strong sign-in, with a way to sign out', async () => {
    session.adminSessionStatus.mockResolvedValue('weak_sign_in')
    render(await AdminGate({ children: <p>Refunds page</p> }))
    expect(screen.getByText(WEAK_SIGN_IN_WORDS)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it.each(['not_admin', 'needs_code'])('is a 404 for %s', async (status) => {
    session.adminSessionStatus.mockResolvedValue(status)
    await expect(AdminGate({ children: null })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})

describe('SideBanner', () => {
  it('says nothing on the live side, and words the test side and a test admin', () => {
    const { container } = render(<SideBanner admin={{ testOnly: false }} side="live" />)
    expect(container).toBeEmptyDOMElement()
    render(<SideBanner admin={{ testOnly: true }} side="test" />)
    expect(screen.getByRole('note')).toHaveTextContent(/Test administrator: live records/)
  })
})

describe('SideSwitch', () => {
  it('presses the side in use and switches to the other, then refreshes', async () => {
    const user = userEvent.setup()
    render(<SideSwitch side="live" testOnly={false} />)
    const group = screen.getByRole('group', { name: 'Records shown' })
    expect(within(group).getByRole('button', { name: 'Live' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(group).getByRole('button', { name: 'Test' }))
    expect(execute).toHaveBeenCalledWith({ side: 'test' })
    expect(refresh).toHaveBeenCalled()
  })

  it('does nothing for the side already in use', async () => {
    const user = userEvent.setup()
    render(<SideSwitch side="live" testOnly={false} />)
    await user.click(screen.getByRole('button', { name: 'Live' }))
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps a test admin off the live side', () => {
    render(<SideSwitch side="test" testOnly />)
    expect(screen.getByRole('button', { name: 'Live' })).toBeDisabled()
  })
})

describe('AdminSidebar', () => {
  it('lists every admin page, marks the current one, and reads counts inside the link names', async () => {
    pathname = '/admin/refunds'
    render(await AdminSidebar())
    const nav = screen.getAllByRole('navigation', { name: 'Admin' })[0] as HTMLElement
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual(ADMIN_NAV_HREFS)
    expect(within(nav).getByRole('link', { name: 'Refunds, 3 need a person' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: 'Emails, 5 failed' })).toBeInTheDocument()
    expect(
      within(nav).getByRole('link', { name: 'Settings, 1 preset drafts open' }),
    ).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(screen.getAllByRole('link', { name: 'Back to your account' })[0]).toHaveAttribute(
      'href',
      '/app/domains',
    )
    expect(attention.getAttentionCounts).toHaveBeenCalledWith('live')
  })

  it('shows no pages to a session SQL refuses', async () => {
    session.findAdmin.mockResolvedValue(null)
    render(await AdminSidebar())
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull()
    expect(attention.getAttentionCounts).not.toHaveBeenCalled()
  })

  it('leaves the badges off when the counts could not be read', async () => {
    attention.getAttentionCounts.mockResolvedValue(null)
    render(await AdminSidebar())
    expect(screen.getAllByRole('link', { name: 'Refunds' })[0]).toBeInTheDocument()
  })

  it('has a page for every package, B1 to B14', () => {
    expect(ADMIN_NAV.flatMap((group) => group.items)).toHaveLength(14)
    render(<AdminSidebarSkeleton />)
  })
})

describe('AdminPlaceholder', () => {
  it('asks SQL who is looking, and shows the side and where the work is done for now', async () => {
    render(
      await AdminPlaceholder({
        title: 'Refund',
        description: 'One refund.',
        parent: { label: 'Refunds', href: '/admin/refunds' },
      }),
    )
    expect(session.requireAdmin).toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 1, name: 'Refund' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Refunds' })).toHaveAttribute('href', '/admin/refunds')
    expect(screen.getByRole('group', { name: 'Records shown' })).toBeInTheDocument()
    expect(screen.getByText(/docs\/DEPLOY.md §6/)).toBeInTheDocument()
  })
})
