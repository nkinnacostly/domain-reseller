import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { createAccount, switchAccount, updateProfile } from '../actions/accounts'
import {
  acceptInvite,
  changeMemberRole,
  createInvite,
  leaveAccount,
  removeMember,
  revokeInvite,
  transferOwnership,
} from '../actions/members'
import { AcceptInvite } from '../components/accept-invite'
import { AccountSwitcher } from '../components/account-switcher'
import { ComingSoon } from '../components/coming-soon'
import { DashboardFrame } from '../components/dashboard-frame'
import { DashboardSkeleton } from '../components/dashboard-skeleton'
import { InviteForm, PendingInvites } from '../components/invites'
import { LeaveAccount, TransferOwnership } from '../components/leave-transfer'
import { MembersList } from '../components/members-list'
import { OnboardingForm } from '../components/onboarding-form'
import { DayCounts, NextStepsList, PartError, UsageMeter } from '../components/overview-parts'
import { ProfileForm } from '../components/profile-form'
import { SettingsNav } from '../components/settings-nav'
import { StateBanner } from '../components/state-banner'
import { accountBanner } from '../lib/state'
import { nextSteps } from '../lib/steps'
import { meter } from '../lib/usage'
import type { Member } from '../queries/members'
import { ACCOUNT, INVITE, OTHER_USER } from './fake-supabase'

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))
const path = vi.hoisted(() => ({ current: '/dashboard' }))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => path.current,
}))
vi.mock('../actions/accounts', () => ({
  createAccount: vi.fn(),
  switchAccount: vi.fn(),
  updateProfile: vi.fn(),
}))
vi.mock('../actions/members', () => ({
  createInvite: vi.fn(),
  revokeInvite: vi.fn(),
  acceptInvite: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
  leaveAccount: vi.fn(),
  transferOwnership: vi.fn(),
}))
vi.mock('@/features/auth/actions/session', () => ({ signOut: vi.fn() }))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

const assign = vi.fn()

beforeAll(() => {
  // Radix asks for these; jsdom has none.
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  path.current = '/dashboard'
})

const ada: Member = {
  userId: 'user-1',
  email: 'ada@example.com',
  name: 'Ada Owner',
  role: 'owner',
  joinedAt: '2026-10-01T10:00:00Z',
}
const bola: Member = {
  userId: OTHER_USER,
  email: 'bola@example.com',
  name: 'Bola',
  role: 'developer',
  joinedAt: '2026-10-02T10:00:00Z',
}

describe('the shell (MAIL-SPEC §10)', () => {
  const accounts = [
    { id: ACCOUNT, name: 'Acme', role: 'owner' as const, state: 'sandbox' as const },
    { id: 'other', name: 'Beta', role: 'viewer' as const, state: 'active' as const },
  ]

  it('frames the page with the sidebar, one main, and you', () => {
    render(
      <DashboardFrame accounts={accounts} currentId={ACCOUNT} email="ada@example.com">
        <p>Page</p>
      </DashboardFrame>,
    )
    expect(screen.getByRole('main')).toHaveTextContent('Page')
    expect(screen.getByRole('navigation', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Your security' })).toHaveAttribute(
      'href',
      '/dashboard/settings/security',
    )
  })

  it('opens the drawer on a phone, and closes it once a page is chosen', async () => {
    const user = userEvent.setup()
    render(
      <DashboardFrame accounts={accounts} currentId={ACCOUNT} email={null}>
        <p>Page</p>
      </DashboardFrame>,
    )
    await user.click(screen.getByRole('button', { name: /^Menu/ }))
    const drawer = await screen.findByRole('dialog', { name: 'Dashboard menu' })
    await user.click(within(drawer).getByRole('link', { name: 'Emails' }))
    expect(screen.queryByRole('dialog', { name: 'Dashboard menu' })).not.toBeInTheDocument()
  })

  it('switches account: the current one ticked, the others a choice, then a refresh', async () => {
    answer(switchAccount, { data: { ok: true } })
    const user = userEvent.setup()
    render(<AccountSwitcher accounts={accounts} currentId={ACCOUNT} />)
    const trigger = screen.getByRole('button', { name: /Current account: Acme/ })
    expect(trigger).toHaveTextContent('Owner · Sandbox')
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitemradio', { name: /Acme/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Create another account' })).toHaveAttribute(
      'href',
      '/onboarding',
    )
    await user.click(within(menu).getByRole('menuitemradio', { name: /Beta/ }))
    expect(switchAccount).toHaveBeenCalledWith({ accountId: 'other' })
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled())
  })

  it('draws nothing for nobody', () => {
    const { container } = render(<AccountSwitcher accounts={[]} currentId="x" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the banner in words and an icon, with the way to the next steps in the sandbox', () => {
    render(
      <StateBanner banner={accountBanner({ state: 'sandbox', sesStatus: 'enabled' }, null, 100)} />,
    )
    const banner = screen.getByRole('region', { name: 'Account status' })
    expect(banner).toHaveTextContent('This account is in the sandbox')
    expect(within(banner).getByRole('link', { name: 'See the next steps' })).toHaveAttribute(
      'href',
      '/dashboard#next-steps',
    )
    const { container } = render(<StateBanner banner={null} />)
    expect(container).toBeEmptyDOMElement()
    render(
      <StateBanner banner={accountBanner({ state: 'paused', sesStatus: 'enabled' }, null, null)} />,
    )
    expect(screen.getAllByRole('region', { name: 'Account status' })[1]).not.toHaveTextContent(
      'next steps',
    )
  })

  it('says a page is coming, and claims nothing it does not do', () => {
    render(<ComingSoon title="Emails" will="The email log will be here." arrives="before launch" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Emails' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'This page is coming' })).toBeInTheDocument()
    expect(screen.getByText('It is not built yet: it arrives before launch.')).toBeInTheDocument()
  })

  it('loads as a skeleton, saying so to screen readers', () => {
    render(<DashboardSkeleton />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading your dashboard')
    expect(screen.getByRole('main')).toBeInTheDocument()
  })

  it('marks the settings section you are on (S13)', () => {
    path.current = '/dashboard/settings/members'
    render(<SettingsNav />)
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    expect(within(nav).getByRole('link', { name: 'Members' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: 'Profile' })).not.toHaveAttribute('aria-current')
  })
})

describe('the Overview’s parts', () => {
  it('draws a cap as a meter with its numbers, and words 80% and 100%', () => {
    render(
      <>
        <UsageMeter label="This month" meter={meter(2500, 3000)} />
        <UsageMeter label="Today" meter={meter(100, 100)} />
      </>,
    )
    const month = screen.getByRole('meter', { name: 'This month' })
    expect(month).toHaveAttribute('max', '3000')
    expect(month).toHaveAttribute('aria-valuetext', '2,500 of 3,000 emails, 83%')
    expect(screen.getByText('Over 80% used')).toBeInTheDocument()
    expect(screen.getByText(/Cap reached/)).toBeInTheDocument()
  })

  it('lists today’s sends by outcome', () => {
    render(
      <DayCounts
        counts={{ queued: 3, sent: 3, delivered: 2, bounced: 1, complained: 0, failed: 0 }}
      />,
    )
    expect(screen.getByText('Bounced').nextSibling).toHaveTextContent('1')
  })

  it('marks each step done, to do, or for someone else, in words', () => {
    render(
      <NextStepsList
        steps={nextSteps({
          state: 'sandbox',
          role: 'viewer',
          verifiedDomains: 0,
          activeKeys: null,
          profileComplete: true,
        })}
      />,
    )
    const step = (id: string) => document.querySelector(`[data-step="${id}"]`) as HTMLElement
    expect(step('domain')).toHaveTextContent('To do')
    expect(within(step('domain')).getByRole('link', { name: 'Verify a domain' })).toHaveAttribute(
      'href',
      '/dashboard/domains',
    )
    expect(step('profile')).toHaveTextContent('Done')
    expect(within(step('profile')).queryByRole('link')).not.toBeInTheDocument()
    expect(step('key')).toHaveTextContent('Ask a developer or admin')
  })

  it('says what could not load, and offers to try again', () => {
    render(<PartError what="this month’s usage" retryHref="/dashboard" />)
    expect(screen.getByRole('alert')).toHaveTextContent('We couldn’t load this month’s usage')
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/dashboard')
  })
})

describe('onboarding and the profile (§7.1)', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('Account name'), 'Acme')
    await user.type(screen.getByLabelText('Website'), 'acme.example')
    await user.type(screen.getByLabelText('What will you send?'), 'Order receipts.')
    await user.type(screen.getByLabelText('About how many emails a month?'), '5000')
  }

  it('sends the answers and the confirmation, then loads the dashboard afresh', async () => {
    answer(createAccount, { data: { ok: true } })
    const user = userEvent.setup()
    render(<OnboardingForm />)
    await fill(user)
    await user.click(screen.getByLabelText('I will send transactional email only'))
    await user.click(screen.getByRole('button', { name: 'Create the account' }))
    expect(createAccount).toHaveBeenCalledWith({
      name: 'Acme',
      website: 'acme.example',
      useCase: 'Order receipts.',
      expectedMonthlyVolume: '5000',
      transactionalOnly: true,
    })
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard?welcome=1'))
    expect(screen.getByRole('link', { name: 'Acceptable Use Policy' })).toHaveAttribute(
      'href',
      '/legal/acceptable-use',
    )
  })

  it('shows SQL’s refusal and a field’s message where they belong', async () => {
    answer(createAccount, { data: { error: 'You already own 3 open Mail accounts.' } })
    const user = userEvent.setup()
    render(<OnboardingForm />)
    await user.click(screen.getByRole('button', { name: 'Create the account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You already own 3')
    answer(createAccount, {
      validationErrors: { transactionalOnly: { _errors: ['Tick the box.'] } },
    })
    await user.click(screen.getByRole('button', { name: 'Create the account' }))
    expect(await screen.findByText('Tick the box.')).toBeInTheDocument()
    expect(screen.getByLabelText('I will send transactional email only')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(assign).not.toHaveBeenCalled()
  })

  it('edits the profile from what is saved, and says whether anything changed', async () => {
    answer(updateProfile, { data: { ok: true, changed: 1 } })
    const user = userEvent.setup()
    render(
      <ProfileForm
        accountId={ACCOUNT}
        profile={{
          name: 'Acme',
          website: 'https://acme.example',
          useCase: 'Receipts',
          expectedMonthlyVolume: 10,
        }}
      />,
    )
    expect(screen.getByLabelText('Website')).toHaveValue('https://acme.example')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(updateProfile).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      name: 'Acme',
      website: 'https://acme.example',
      useCase: 'Receipts',
      expectedMonthlyVolume: '10',
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    answer(updateProfile, { data: { ok: true, changed: 0 } })
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(await screen.findByText(/Nothing had changed/)).toBeInTheDocument()
    answer(updateProfile, { serverError: 'Something went wrong on our end.' })
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
  })
})

describe('members (§9, §10 Settings)', () => {
  it('offers the owner changes to others, never to themselves', () => {
    render(<MembersList accountId={ACCOUNT} members={[ada, bola]} me="user-1" myRole="owner" />)
    const mine = screen.getByText('Ada Owner').closest('li') as HTMLElement
    const theirs = screen.getByText('Bola').closest('li') as HTMLElement
    expect(mine).toHaveTextContent('(you)')
    expect(within(mine).queryByRole('button')).not.toBeInTheDocument()
    expect(within(theirs).getByRole('button', { name: 'Change role' })).toBeInTheDocument()
    expect(within(theirs).getByRole('combobox', { name: 'Role' })).toHaveValue('developer')
  })

  it('offers a viewer nothing to change', () => {
    render(
      <MembersList accountId={ACCOUNT} members={[ada, bola]} me={OTHER_USER} myRole="viewer" />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('changes a role, and shows a refusal in the row', async () => {
    answer(changeMemberRole, { data: { ok: true } })
    const user = userEvent.setup()
    render(<MembersList accountId={ACCOUNT} members={[ada, bola]} me="user-1" myRole="owner" />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'viewer')
    await user.click(screen.getByRole('button', { name: 'Change role' }))
    expect(changeMemberRole).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      userId: OTHER_USER,
      role: 'viewer',
    })
    expect(await screen.findByText('Role changed.')).toBeInTheDocument()
    expect(router.refresh).toHaveBeenCalled()
    answer(changeMemberRole, { data: { error: 'Your role in this account cannot do that.' } })
    await user.click(screen.getByRole('button', { name: 'Change role' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot do that')
  })

  it('removes a member after asking, and keeps the dialog for a refusal', async () => {
    answer(removeMember, { data: { error: 'That person is no longer a member of this account.' } })
    const user = userEvent.setup()
    render(<MembersList accountId={ACCOUNT} members={[ada, bola]} me="user-1" myRole="owner" />)
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Bola?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove from the account' }))
    expect(removeMember).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: OTHER_USER })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no longer a member')
    answer(removeMember, { data: { ok: true } })
    await user.click(within(dialog).getByRole('button', { name: 'Remove from the account' }))
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(router.refresh).toHaveBeenCalled()
  })

  it('makes an invite link, shows it once, and copies it', async () => {
    answer(createInvite, {
      data: {
        link: 'https://emails.mydomainshub.com/invite?token=tok',
        expiresAt: '2026-10-13T10:00:00Z',
      },
    })
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    render(<InviteForm accountId={ACCOUNT} myRole="admin" />)
    expect(
      screen.getAllByRole('option').map((option) => (option as HTMLOptionElement).value),
    ).toEqual(['developer', 'viewer'])
    await user.type(screen.getByLabelText('Their email'), 'Bola@Example.com')
    await user.click(screen.getByRole('button', { name: 'Make an invite link' }))
    expect(createInvite).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      email: 'Bola@Example.com',
      role: 'developer',
    })
    expect(await screen.findByText('Invite ready for bola@example.com')).toBeInTheDocument()
    expect(screen.getByText(/We don’t email invites yet/)).toBeInTheDocument()
    expect(screen.getByLabelText('Invite link')).toHaveValue(
      'https://emails.mydomainshub.com/invite?token=tok',
    )
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledWith('https://emails.mydomainshub.com/invite?token=tok')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Invite someone else' }))
    expect(screen.getByLabelText('Their email')).toBeInTheDocument()
  })

  it('says when copying failed, and how to copy by hand', async () => {
    answer(createInvite, { data: { link: 'https://x.test/invite?token=t', expiresAt: '' } })
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    const user = userEvent.setup()
    render(<InviteForm accountId={ACCOUNT} myRole="owner" />)
    await user.type(screen.getByLabelText('Their email'), 'b@example.com')
    await user.click(screen.getByRole('button', { name: 'Make an invite link' }))
    await user.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(await screen.findByText(/select the link and copy it/)).toBeInTheDocument()
    expect(screen.getByText(/until in seven days/)).toBeInTheDocument()
  })

  it('shows a refused invite and its field', async () => {
    answer(createInvite, { data: { error: 'This plan has 1 member seat.' } })
    const user = userEvent.setup()
    render(<InviteForm accountId={ACCOUNT} myRole="owner" />)
    await user.click(screen.getByRole('button', { name: 'Make an invite link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('1 member seat')
  })

  it('lists invites waiting, revoking only those the role may', async () => {
    answer(revokeInvite, { data: { ok: true } })
    const user = userEvent.setup()
    const invites = [
      {
        id: INVITE,
        email: 'b@example.com',
        role: 'viewer' as const,
        createdAt: 'c',
        expiresAt: '2026-10-13T10:00:00Z',
      },
      {
        id: 'i-2',
        email: 'c@example.com',
        role: 'admin' as const,
        createdAt: 'c',
        expiresAt: '2026-10-13T10:00:00Z',
      },
    ]
    render(<PendingInvites accountId={ACCOUNT} invites={invites} myRole="admin" />)
    const waiting = screen.getByText('b@example.com').closest('li') as HTMLElement
    const admin = screen.getByText('c@example.com').closest('li') as HTMLElement
    expect(within(admin).queryByRole('button')).not.toBeInTheDocument()
    await user.click(within(waiting).getByRole('button', { name: /Revoke/ }))
    expect(revokeInvite).toHaveBeenCalledWith({ accountId: ACCOUNT, inviteId: INVITE })
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled())
  })

  it('says when no invites are waiting', () => {
    render(<PendingInvites accountId={ACCOUNT} invites={[]} myRole="owner" />)
    expect(screen.getByText('No invites are waiting.')).toBeInTheDocument()
  })

  it('leaves after asking, then loads the dashboard afresh', async () => {
    answer(leaveAccount, { data: { ok: true } })
    const user = userEvent.setup()
    render(<LeaveAccount accountId={ACCOUNT} accountName="Acme" />)
    await user.click(screen.getByRole('button', { name: 'Leave this account' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave Acme?' })
    await user.click(within(dialog).getByRole('button', { name: 'Leave the account' }))
    expect(leaveAccount).toHaveBeenCalledWith({ accountId: ACCOUNT })
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'))
  })

  it('hands the account over: chosen, typed, asked, done', async () => {
    answer(transferOwnership, { data: { ok: true } })
    const user = userEvent.setup()
    render(<TransferOwnership accountId={ACCOUNT} accountName="Acme" candidates={[bola]} />)
    await user.type(screen.getByLabelText(/Type the account’s name/), 'Acme')
    await user.click(screen.getByRole('button', { name: 'Hand the account over' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Make Bola the owner?' })
    await user.click(within(dialog).getByRole('button', { name: 'Hand it over' }))
    expect(transferOwnership).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      userId: OTHER_USER,
      confirmName: 'Acme',
    })
    expect(await screen.findByText(/You are now an admin/)).toBeInTheDocument()
  })

  it('shows a refused hand-over in the dialog, and says who can be chosen', async () => {
    answer(transferOwnership, { data: { error: 'That is not the account’s name.' } })
    const user = userEvent.setup()
    render(<TransferOwnership accountId={ACCOUNT} accountName="Acme" candidates={[bola]} />)
    await user.click(screen.getByRole('button', { name: 'Hand the account over' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Hand it over' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('not the account’s name')
    render(<TransferOwnership accountId={ACCOUNT} accountName="Acme" candidates={[]} />)
    expect(screen.getByText(/invite the person first/)).toBeInTheDocument()
  })
})

describe('accepting an invite', () => {
  it('joins, then loads the dashboard afresh', async () => {
    answer(acceptInvite, { data: { ok: true } })
    const user = userEvent.setup()
    render(<AcceptInvite token="tok" accountName="Acme" />)
    await user.click(screen.getByRole('button', { name: 'Join Acme' }))
    expect(acceptInvite).toHaveBeenCalledWith({ token: 'tok' })
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'))
  })

  it('says why it could not', async () => {
    answer(acceptInvite, { data: { error: 'That invite has expired.' } })
    const user = userEvent.setup()
    render(<AcceptInvite token="tok" accountName="Acme" />)
    await user.click(screen.getByRole('button', { name: 'Join Acme' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('expired')
  })

  it('shows that it is joining', async () => {
    hang(acceptInvite)
    const user = userEvent.setup()
    render(<AcceptInvite token="tok" accountName="Acme" />)
    await user.click(screen.getByRole('button', { name: 'Join Acme' }))
    expect(await screen.findByRole('button', { name: 'Joining…' })).toBeDisabled()
  })
})

describe('ConfirmDialog', () => {
  it('cannot be dismissed while its action runs', async () => {
    const changed = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={changed}
        title="Sure?"
        description="It happens at once."
        confirmLabel="Do it"
        pendingLabel="Doing…"
        pending
        onConfirm={vi.fn()}
      />,
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Sure?' })
    expect(within(dialog).getByRole('button', { name: 'Doing…' })).toBeDisabled()
    await userEvent.setup().keyboard('{Escape}')
    expect(changed).not.toHaveBeenCalled()
  })
})
