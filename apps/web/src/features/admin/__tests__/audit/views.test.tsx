import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditSkeleton, AuditView } from '@/features/admin/components/audit/audit-view'
import {
  AUDIT_READ_FAILED,
  AUDIT_SIDES_NOTE,
  AUDIT_TEST_ADMIN_NOTE,
  HIDDEN_VALUE,
  NO_DETAIL,
} from '@/features/admin/lib/audit-copy'
import { type AuditEntry, listAuditEntries } from '@/features/admin/queries/audit'
import { getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { ids } from './fake-db'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/admin/audit',
}))
vi.mock('@/features/admin/queries/session', () => ({
  requireAdmin: vi.fn(),
  getAdminSide: vi.fn(),
}))
vi.mock('@/features/admin/queries/audit', () => ({ listAuditEntries: vi.fn() }))

const owner = { role: 'owner', testOnly: false, label: 'owner' }
const testAdmin = { role: 'operator', testOnly: true, label: 'e2e-1a2b3c4d' }

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 101,
    createdAt: '2026-10-03T11:05:00Z',
    adminLabel: 'e2e-1a2b3c4d',
    adminRole: 'operator',
    testActor: true,
    session: 'abcdef01',
    action: 'refund.approve',
    side: 'test',
    targetType: 'refund',
    targetId: ids.refund,
    targetTestMode: true,
    reason: 'Customer asked about the failed name',
    redactedAt: null,
    outcome: 'ok',
    errorCode: null,
    detail: [
      { label: 'before.status', value: 'held', hidden: false },
      { label: 'contact', value: HIDDEN_VALUE, hidden: true },
    ],
    parentId: null,
    requestId: ids.request,
    result: null,
    ...overrides,
  }
}

async function show(search: Record<string, string> = {}) {
  render(await AuditView({ searchParams: Promise.resolve(search) }))
}

/** The table's copy of the rows: the cards are the same rows, for narrow screens. */
const table = () => screen.getByRole('table', { name: /^Audit entries/ })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAdmin).mockResolvedValue(owner as never)
  vi.mocked(getAdminSide).mockResolvedValue('live')
})

describe('AuditView', () => {
  it('reads the log from the URL and shows each entry’s columns', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 1 })
    await show({ action: 'refund', outcome: 'ok' })

    expect(listAuditEntries).toHaveBeenCalledWith(
      owner,
      'live',
      expect.objectContaining({ prefix: 'refund', outcome: ['ok'] }),
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Audit log' })).toBeInTheDocument()
    expect(screen.getByTestId('audit-scope-note')).toHaveTextContent(AUDIT_SIDES_NOTE)
    const headers = within(table())
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent?.replace(/\(.*\)/, '').trim())
    expect(headers).toEqual([
      'When',
      'Admin',
      'Action',
      'Target',
      'Side',
      'Reason',
      'Result',
      'Request id',
      'Details',
    ])
    const row = within(table()).getAllByRole('row')[1] as HTMLElement
    expect(within(row).getByRole('link', { name: 'Entry #101' })).toHaveAttribute(
      'href',
      '/admin/audit?id=101',
    )
    expect(row.querySelector('time')).toHaveTextContent('3 Oct 2026, 12:05 WAT')
    expect(row.querySelector('time')).toHaveAttribute('dateTime', '2026-10-03T11:05:00Z')
    expect(
      within(row).getByRole('link', { name: 'e2e-1a2b3c4d: only this admin’s entries' }),
    ).toHaveAttribute('href', '/admin/audit?action=refund&outcome=ok&admin=e2e-1a2b3c4d')
    // The Test badge beside the label, and the side.
    expect(within(row).getAllByText('Test')).toHaveLength(2)
    expect(within(row).getByText('Approve a refund')).toBeInTheDocument()
    expect(within(row).getByText('refund.approve')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Refund 7a7b7c7d' })).toHaveAttribute(
      'href',
      `/admin/refunds/${ids.refund}`,
    )
    expect(within(row).getByText('Customer asked about the failed name')).toBeInTheDocument()
    expect(within(row).getByText('Done')).toBeInTheDocument()
    expect(within(row).getByText('5e5f6a6b')).toBeInTheDocument()
  })

  it('expands an entry’s details: the facts, then what was recorded, hidden values said so', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 1 })
    await show()
    const row = within(table()).getAllByRole('row')[1] as HTMLElement
    const summary = row.querySelector('summary') as HTMLElement
    expect(summary).toHaveTextContent(/details of entry #101$/)
    const details = summary.closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    await userEvent.click(summary)
    expect(details.open).toBe(true)
    const facts = within(details)
    expect(facts.getByText('Sign-in').nextSibling).toHaveTextContent('abcdef01')
    expect(facts.getByText('Target', { selector: 'dt' }).nextSibling).toHaveTextContent(
      `Refund ${ids.refund}`,
    )
    expect(facts.getByText('A test record').nextSibling).toHaveTextContent('yes')
    expect(facts.getByText('Request id').nextSibling).toHaveTextContent(ids.request)
    expect(facts.getByText('before.status').closest('div')).toHaveTextContent('held')
    expect(facts.getByText('contact').closest('div')).toHaveTextContent(HIDDEN_VALUE)
  })

  it('shows an intent note’s gateway result inline, and a result’s note', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({
      rows: [
        entry({
          id: 201,
          action: 'supplier.domain_lookup',
          outcome: 'intent',
          targetType: 'domain',
          targetId: 'shop.example.com',
          reason: null,
          detail: [],
          result: {
            id: 205,
            outcome: 'refused',
            errorCode: 'TOO_SOON',
            createdAt: '2026-10-03T11:06:00Z',
          },
        }),
        entry({
          id: 202,
          action: 'supplier.balance',
          outcome: 'intent',
          targetType: 'supplier',
          targetId: 'test',
          requestId: null,
          session: null,
          targetTestMode: null,
          detail: [],
        }),
        entry({ id: 205, outcome: 'refused', errorCode: 'TOO_SOON', parentId: 201 }),
      ],
      total: 3,
    })
    await show()
    const [, first, second, third] = within(table()).getAllByRole('row') as HTMLElement[]
    expect(within(first as HTMLElement).getByText('Asked')).toBeInTheDocument()
    expect(within(first as HTMLElement).getByText('Refused: TOO_SOON')).toBeInTheDocument()
    // A domain looked up is named, never linked by its name (N13).
    expect(within(first as HTMLElement).getByText('Domain shop.example.com').tagName).toBe('SPAN')
    expect(within(first as HTMLElement).getByText('—', { selector: 'td' })).toBeInTheDocument()
    expect(
      within(first as HTMLElement).getByRole('link', { name: /^Entry #205, / }),
    ).toHaveAttribute('href', '/admin/audit?id=205')
    expect(within(first as HTMLElement).getByText(NO_DETAIL)).toBeInTheDocument()

    expect(within(second as HTMLElement).getByText('No result recorded')).toBeInTheDocument()
    expect(within(second as HTMLElement).getByText('Supplier · test')).toBeInTheDocument()

    expect(within(third as HTMLElement).getByText('TOO_SOON')).toBeInTheDocument()
    expect(
      within(third as HTMLElement).getByRole('link', { name: 'For entry #201' }),
    ).toHaveAttribute('href', '/admin/audit?id=201')
    expect(
      within(third as HTMLElement).getByText(
        'This was read moments ago. Wait a little before reading it again.',
      ),
    ).toBeInTheDocument()
  })

  it('says when a reason was redacted, never what it was', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({
      rows: [entry({ reason: null, redactedAt: '2026-10-03T12:00:00Z', side: null })],
      total: 1,
    })
    await show()
    const row = within(table()).getAllByRole('row')[1] as HTMLElement
    expect(within(row).getByText('Redacted on 3 Oct 2026')).toBeInTheDocument()
  })

  it('has no control that changes an entry, for anyone', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 1 })
    await show()
    const main = document.body
    expect(within(main).queryAllByRole('button', { name: /redact|edit|delete|remove/i })).toEqual(
      [],
    )
    // The only buttons: the filter form's Show, and each details summary is not a button.
    expect(
      within(main)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Show'])
    for (const form of main.querySelectorAll('form')) expect(form.method).toBe('get')
  })

  it('offers every filter: action, result, side, who, and the admin and days', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 1 })
    await show({ action: 'supplier', outcome: 'intent', admin: 'owner', from: '2026-10-01' })
    const action = screen.getByRole('navigation', { name: 'Action' })
    expect(within(action).getByRole('link', { name: 'Supplier' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    // Choosing the chosen family clears it.
    expect(within(action).getByRole('link', { name: 'Supplier' })).toHaveAttribute(
      'href',
      '/admin/audit?outcome=intent&admin=owner&from=2026-10-01',
    )
    expect(within(action).getByRole('link', { name: 'Refunds' })).toHaveAttribute(
      'href',
      '/admin/audit?action=refund&outcome=intent&admin=owner&from=2026-10-01',
    )
    const result = screen.getByRole('navigation', { name: 'Result' })
    expect(within(result).getByRole('link', { name: 'Refused' })).toHaveAttribute(
      'href',
      '/admin/audit?action=supplier&outcome=intent%2Crefused&admin=owner&from=2026-10-01',
    )
    const side = screen.getByRole('navigation', { name: 'Side' })
    expect(within(side).getByRole('link', { name: 'Live' })).toHaveAttribute(
      'href',
      '/admin/audit?action=supplier&outcome=intent&side=live&admin=owner&from=2026-10-01',
    )
    const who = screen.getByRole('navigation', { name: 'Who' })
    expect(within(who).getByRole('link', { name: 'Test administrators' })).toHaveAttribute(
      'href',
      '/admin/audit?action=supplier&outcome=intent&who=test&admin=owner&from=2026-10-01',
    )
    const form = screen.getByRole('form', { name: 'Admin and dates' })
    expect(within(form).getByLabelText('Admin label')).toHaveValue('owner')
    expect(within(form).getByLabelText('Admin label')).toHaveAttribute(
      'pattern',
      '[A-Za-z][A-Za-z0-9_\\-]{1,30}',
    )
    expect(within(form).getByLabelText('From (WAT)')).toHaveValue('2026-10-01')
    expect(form.querySelector('input[type="hidden"][name="action"]')).toHaveValue('supplier')
    expect(form.querySelector('input[type="hidden"][name="outcome"]')).toHaveValue('intent')
    expect(within(form).getByRole('link', { name: 'Any admin, any date' })).toHaveAttribute(
      'href',
      '/admin/audit?action=supplier&outcome=intent',
    )
  })

  it('sorts by when, both ways, and pages through the log', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 120 })
    await show({ page: '2' })
    expect(within(table()).getByRole('link', { name: /^When/ })).toHaveAttribute(
      'href',
      '/admin/audit?dir=asc',
    )
    const pages = screen.getByRole('navigation', { name: 'Pages' })
    expect(within(pages).getByText('Page 2 of 3 · 120 in all')).toBeInTheDocument()
    expect(within(pages).getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/admin/audit?page=3',
    )
    expect(within(pages).getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/admin/audit',
    )
  })

  it('reads oldest first when asked', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 1 })
    await show({ dir: 'asc' })
    expect(screen.getByRole('table', { name: 'Audit entries, oldest first' })).toBeInTheDocument()
  })

  it('shows a test administrator their own kind of entries, with no Who filter', async () => {
    vi.mocked(requireAdmin).mockResolvedValue(testAdmin as never)
    vi.mocked(getAdminSide).mockResolvedValue('test')
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 1 })
    await show({ who: 'admins' })
    expect(listAuditEntries).toHaveBeenCalledWith(
      testAdmin,
      'test',
      expect.objectContaining({ who: null }),
    )
    expect(screen.getByTestId('audit-scope-note')).toHaveTextContent(AUDIT_TEST_ADMIN_NOTE)
    expect(screen.queryByRole('navigation', { name: 'Who' })).not.toBeInTheDocument()
  })
})

describe('AuditView’s empty and error states', () => {
  it('says nothing has been recorded yet, with no filters', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [], total: 0 })
    await show()
    expect(screen.getByText('Nothing has been recorded yet.')).toBeInTheDocument()
  })

  it('offers to clear filters that match nothing', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [], total: 0 })
    await show({ outcome: 'failed' })
    expect(screen.getByText('No entries match these filters.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear the filters' })).toHaveAttribute(
      'href',
      '/admin/audit',
    )
  })

  it('says when one entry is not there, or not one a test administrator sees', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [], total: 0 })
    await show({ id: '77', action: 'job' })
    expect(screen.getByText('No entry #77 to show.')).toBeInTheDocument()
    expect(screen.getByText('There is no entry with that number.')).toBeInTheDocument()
    expect(screen.getByText('Entry #77 only.')).toBeInTheDocument()
    for (const link of screen.getAllByRole('link', { name: 'Show every entry' })) {
      expect(link).toHaveAttribute('href', '/admin/audit?action=job')
    }

    vi.mocked(requireAdmin).mockResolvedValue(testAdmin as never)
    document.body.innerHTML = ''
    await show({ id: '77' })
    expect(
      screen.getByText(/^There is no such entry, or it is not a test administrator's\./),
    ).toBeInTheDocument()
  })

  it('says it is showing one record’s entries, with a way back', async () => {
    vi.mocked(listAuditEntries).mockResolvedValue({ rows: [entry()], total: 1 })
    await show({ target: ids.refund })
    expect(screen.getByText('Entries about one record only.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show every record' })).toHaveAttribute(
      'href',
      '/admin/audit',
    )
  })

  it('shows the error state with "Try again" when the log cannot be read', async () => {
    vi.mocked(listAuditEntries).mockRejectedValue(new Error('down'))
    await show()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(AUDIT_READ_FAILED)
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalled()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('AuditSkeleton', () => {
  it('pulses while the log loads, hidden from screen readers', () => {
    const { container } = render(<AuditSkeleton />)
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })
})
