import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approveAccount,
  overrideCaps,
  pauseAccount,
  rejectAccount,
  resumeAccount,
} from '../actions/accounts'
import { AccountActions, type AccountForActions } from '../components/account-actions'
import { AccountFindings, findingFacts } from '../components/account-findings'
import { ConfirmAction } from '../components/confirm-action'
import {
  AdminPage,
  Card,
  EmptyState,
  ErrorState,
  Facts,
  FilterLinks,
  Pager,
  PageSkeleton,
  StatTile,
  TableBox,
} from '../components/parts'
import { AdminFrame } from '../components/shell/admin-frame'
import { ADMIN_ERROR_WORDS, LOST_ANSWER_WORDS, SERVER_CRASH_WORDS } from '../lib/errors'
import type { Finding } from '../queries/mail'

/** Mail's admin parts (MAIL-SPEC §10): what each shows, offers and sends — and S8, S11, S12, S13. */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }))
const path = vi.hoisted(() => ({ current: '/admin' }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => path.current }))
vi.mock('../actions/accounts', () => ({
  approveAccount: vi.fn(),
  rejectAccount: vi.fn(),
  pauseAccount: vi.fn(),
  resumeAccount: vi.fn(),
  overrideCaps: vi.fn(),
}))
vi.mock('@/features/auth/actions/session', () => ({ signOut: vi.fn() }))

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.scrollIntoView ??= () => undefined
})

beforeEach(() => {
  vi.clearAllMocks()
  path.current = '/admin'
})

const ACCOUNT = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
const REASON = 'Checked the website and the use case'

const account = (over: Partial<AccountForActions> = {}): AccountForActions => ({
  id: ACCOUNT,
  name: 'Acme',
  tenant: 'mdm-0123456789',
  state: 'sandbox',
  sesStatus: 'enabled',
  dailyOverride: null,
  monthlyOverride: null,
  ...over,
})

const owner = { role: 'owner' as const, testOnly: false }
const done = (after: Record<string, unknown> = {}) => ({ data: { ok: true, auditId: 1, after } })

describe('the confirm dialog (S12)', () => {
  it('needs a reason of ten characters before it runs, then shows the result and refreshes', async () => {
    const user = userEvent.setup()
    const run = vi.fn(async () => ({ ok: true as const, auditId: 1 }))
    render(
      <ConfirmAction
        trigger="Do it"
        title="Do the thing"
        body={<p>What happens.</p>}
        confirmLabel="Confirm"
        successMessage="Done."
        run={run}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Do it' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Do the thing' })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Reason'), 'too short')
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Reason'), ' but now enough')
    await user.click(confirm)
    expect(run).toHaveBeenCalledWith({
      reason: 'too short but now enough',
      requestKey: expect.any(String),
    })
    expect(within(dialog).getByRole('status')).toHaveTextContent('Done.')
    expect(router.refresh).toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks for the code on a money action, takes a new key after a refusal and keeps it after a lost answer', async () => {
    const user = userEvent.setup()
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        code: 'NEEDS_CODE',
        message: ADMIN_ERROR_WORDS.NEEDS_CODE,
      })
      .mockResolvedValueOnce({ ok: false, code: 'UNKNOWN_OUTCOME', message: LOST_ANSWER_WORDS })
      .mockRejectedValueOnce(new Error('network'))
    render(
      <ConfirmAction
        trigger="Resume"
        title="Resume Acme"
        body="Resumes."
        confirmLabel="Resume sending"
        needsCode
        successMessage="Resumed."
        run={run}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    const dialog = screen.getByRole('alertdialog')
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    const code = within(dialog).getByLabelText('Code from your authenticator app')
    const confirm = within(dialog).getByRole('button', { name: 'Resume sending' })
    await user.type(code, '12ab34')
    expect(code).toHaveValue('1234')
    expect(confirm).toBeDisabled()
    await user.type(code, '56')
    await user.click(confirm)
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      ADMIN_ERROR_WORDS.NEEDS_CODE as string,
    )
    expect(code).toHaveValue('')
    await user.type(code, '654321')
    await user.click(confirm)
    await user.type(code, '111111')
    await user.click(confirm)
    expect(within(dialog).getByRole('alert')).toHaveTextContent(LOST_ANSWER_WORDS)
    const keys = run.mock.calls.map(([input]) => (input as { requestKey: string }).requestKey)
    expect(keys[1]).not.toBe(keys[0])
    expect(keys[2]).toBe(keys[1])
    expect(run.mock.calls[0]?.[0]).toMatchObject({ code: '123456' })
  })
})

describe('what an admin may do to an account (§7.2, §7.4, MR5)', () => {
  it('offers approve, reject and pause in the sandbox, and resume and caps to the owner only', () => {
    const { rerender } = render(
      <AccountActions
        account={account()}
        admin={{ role: 'operator', testOnly: false }}
        openPauseFinding={null}
      />,
    )
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Approve',
      'Reject',
      'Pause sending',
    ])
    rerender(
      <AccountActions
        account={account({ state: 'paused' })}
        admin={owner}
        openPauseFinding={{ id: 3, kind: 'bounce_pause' }}
      />,
    )
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Resume sending',
      'Change caps',
    ])
    rerender(
      <AccountActions
        account={account({ state: 'paused' })}
        admin={{ role: 'owner', testOnly: true }}
        openPauseFinding={null}
      />,
    )
    expect(screen.queryAllByRole('button')).toEqual([])
    rerender(
      <AccountActions
        account={account({ state: 'closed' })}
        admin={owner}
        openPauseFinding={null}
      />,
    )
    expect(screen.queryAllByRole('button')).toEqual([])
    rerender(
      <AccountActions
        account={account()}
        admin={{ role: 'viewer', testOnly: false }}
        openPauseFinding={null}
      />,
    )
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('approves, rejects and pauses with the reason and a request key', async () => {
    const user = userEvent.setup()
    vi.mocked(approveAccount).mockResolvedValue(done({ state: 'active' }) as never)
    vi.mocked(rejectAccount).mockResolvedValue({ serverError: SERVER_CRASH_WORDS } as never)
    vi.mocked(pauseAccount).mockResolvedValue(done() as never)
    render(<AccountActions account={account()} admin={owner} openPauseFinding={null} />)
    for (const [button, confirm, action] of [
      ['Approve', 'Approve the account', approveAccount],
      ['Reject', 'Reject and close', rejectAccount],
      ['Pause sending', 'Pause sending', pauseAccount],
    ] as const) {
      await user.click(screen.getByRole('button', { name: button }))
      const dialog = screen.getByRole('alertdialog')
      await user.type(within(dialog).getByLabelText('Reason'), REASON)
      await user.click(within(dialog).getByRole('button', { name: confirm }))
      expect(action).toHaveBeenCalledWith({
        accountId: ACCOUNT,
        reason: REASON,
        requestKey: expect.any(String),
      })
      await user.click(within(dialog).getByRole('button', { name: /Close|Cancel/ }))
    }
  })

  it('resumes naming the finding read, and says when AWS may hold the tenant', async () => {
    const user = userEvent.setup()
    vi.mocked(resumeAccount).mockResolvedValue(done() as never)
    render(
      <AccountActions
        account={account({ state: 'paused', sesStatus: 'disabled' })}
        admin={owner}
        openPauseFinding={{ id: 3, kind: 'bounce_pause' }}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Resume sending' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('Bounces over our pause level')
    expect(dialog).toHaveTextContent('AWS support case')
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.click(within(dialog).getByRole('button', { name: 'Resume sending' }))
    expect(resumeAccount).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      findingId: 3,
      reason: REASON,
      requestKey: expect.any(String),
      code: '123456',
    })
  })

  it('changes caps: empty keeps the plan’s, nonsense keeps the button off', async () => {
    const user = userEvent.setup()
    vi.mocked(overrideCaps).mockResolvedValue(done() as never)
    render(
      <AccountActions
        account={account({ state: 'active', dailyOverride: 200 })}
        admin={owner}
        openPauseFinding={null}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Change caps' }))
    const dialog = screen.getByRole('alertdialog')
    const daily = within(dialog).getByLabelText('Daily cap')
    expect(daily).toHaveValue('200')
    await user.type(within(dialog).getByLabelText('Reason'), REASON)
    await user.type(within(dialog).getByLabelText('Code from your authenticator app'), '123456')
    await user.clear(daily)
    await user.type(daily, '0')
    expect(within(dialog).getByRole('button', { name: 'Save the caps' })).toBeDisabled()
    expect(dialog).toHaveTextContent('A whole number of at least 1, or empty.')
    await user.clear(daily)
    await user.type(daily, '1,500')
    await user.click(within(dialog).getByRole('button', { name: 'Save the caps' }))
    expect(overrideCaps).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      dailyCap: 1500,
      monthlyCap: null,
      reason: REASON,
      requestKey: expect.any(String),
      code: '123456',
    })
  })
})

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 1,
  source: 'threshold',
  kind: 'bounce_pause',
  severity: 'pause',
  detail: { sent: 600, bouncePpm: 50_000, complaintPpm: 0, windowDays: 7 },
  openedAt: '2026-10-06T10:00:00Z',
  resolvedAt: null,
  resolvedBy: null,
  resolution: null,
  ...over,
})

describe('findings (MR5: read before a resume)', () => {
  it('shows ours and SES’s, open ones as such, with what the threshold measured', () => {
    render(
      <AccountFindings
        findings={[
          finding(),
          finding({
            id: 2,
            kind: 'bounce_warning',
            severity: 'warning',
            resolvedAt: '2026-10-06T11:00:00Z',
            resolution: 'cleared',
            resolvedBy: 'system',
          }),
          finding({
            id: 3,
            source: 'admin',
            kind: 'admin_pause',
            detail: {},
            resolvedAt: '2026-10-06T12:00:00Z',
            resolution: 'resumed',
            resolvedBy: 'owner',
          }),
        ]}
        sesFindings={[
          {
            id: 9,
            source: 'ses',
            kind: 'sending_paused',
            impact: 'high',
            summary: 'Bounce rate too high',
            openedAt: '2026-10-06T09:00:00Z',
            resolvedAt: null,
          },
        ]}
      />,
    )
    expect(screen.getByText('Open: paused')).toBeInTheDocument()
    // The pause and the cleared warning each say what was measured.
    expect(screen.getAllByText('Bounces 5%, complaints 0% over 7 days (600 sent)')).toHaveLength(2)
    expect(screen.getByText(/Cleared: the rates fell/)).toBeInTheDocument()
    expect(screen.getByText(/Closed by a resume .* by owner/)).toBeInTheDocument()
    expect(screen.getByText('Open: from SES')).toBeInTheDocument()
    expect(screen.getByText('Impact: high')).toBeInTheDocument()
    expect(findingFacts(finding({ source: 'admin' }))).toBeNull()
    expect(findingFacts(finding({ detail: {} }))).toBeNull()
  })

  it('says when there are none', () => {
    render(<AccountFindings findings={[]} sesFindings={[]} />)
    expect(screen.getByText('No finding has been opened on this account.')).toBeInTheDocument()
  })
})

describe('the parts (S11, S13)', () => {
  it('draws a titled page, cards, facts, tiles and a focusable scroll box', () => {
    render(
      <AdminPage title="Accounts" intro="All of them" actions={<button type="button">Act</button>}>
        <Card title="Profile" id="p">
          <Facts rows={[{ label: 'Plan', value: 'Free' }]} />
        </Card>
        <StatTile label="Paused" value="2" hint="open" href="/admin/accounts?state=paused" />
        <StatTile label="Sent" value="9" />
        <TableBox label="Accounts table">
          <table>
            <tbody>
              <tr>
                <td>x</td>
              </tr>
            </tbody>
          </table>
        </TableBox>
      </AdminPage>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Paused/ })).toHaveAttribute(
      'href',
      '/admin/accounts?state=paused',
    )
    expect(screen.getByRole('region', { name: 'Accounts table' })).toHaveAttribute('tabindex', '0')
  })

  it('words a refusal and a failure, each with its next step', () => {
    const { rerender } = render(<ErrorState code="test_admin" retryHref="/admin/health" />)
    expect(screen.getByRole('alert')).toHaveTextContent(ADMIN_ERROR_WORDS.test_admin as string)
    expect(screen.queryByRole('link', { name: 'Try again' })).toBeNull()
    rerender(<ErrorState code="read_failed" retryHref="/admin/health" />)
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/admin/health')
  })

  it('pages, filters with the current one marked, and shows empty and loading states', () => {
    render(
      <>
        <EmptyState title="Nothing yet" body="Later." />
        <PageSkeleton />
        <Pager page={2} total={120} pageSize={50} hrefFor={(n) => `/x?page=${n}`} />
        <FilterLinks
          label="Filter by state"
          options={[
            { href: '/x', label: 'All', current: false },
            { href: '/x?state=paused', label: 'Paused', current: true },
          ]}
        />
      </>,
    )
    expect(screen.getByText('Nothing yet')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/x?page=1')
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/x?page=3')
    expect(screen.getByRole('link', { name: 'Paused' })).toHaveAttribute('aria-current', 'page')
    const { container } = render(<Pager page={1} total={10} pageSize={50} hrefFor={() => '/'} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the admin shell', () => {
  it('marks the current page, and links an admin’s own security to the shop', async () => {
    path.current = '/admin/accounts/abc'
    render(
      <AdminFrame roleLabel="Owner" showNav>
        <p>body</p>
      </AdminFrame>,
    )
    const nav = screen.getByRole('navigation', { name: 'Admin' })
    expect(within(nav).getByRole('link', { name: 'Accounts' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: /Password and two-factor/ })).toHaveAttribute(
      'href',
      'https://www.mydomainshub.com/app/settings',
    )
    expect(screen.getByText('Owner')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Menu/ }))
    expect(screen.getByRole('dialog', { name: 'Admin menu' })).toBeInTheDocument()
  })

  it('shows no pages to a session the gate refuses', () => {
    render(
      <AdminFrame roleLabel={null} showNav={false}>
        <p>body</p>
      </AdminFrame>,
    )
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull()
  })
})
