import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminSessionStatus, requireAdmin } from '../queries/session'
import { navigation, whoami } from './fake-admin'

/**
 * The gate every Mail admin page renders through (the shop's ADMIN-SPEC
 * §2.3): an admin gets the page — a test admin with its banner — two
 * refusals only an admin can meet are explained, anything else is a 404.
 */

vi.mock('../queries/session', () => ({ adminSessionStatus: vi.fn(), requireAdmin: vi.fn() }))
vi.mock('@/features/auth/actions/session', () => ({ signOut: vi.fn() }))

const { AdminGate, FACTOR_MISMATCH_WORDS, TEST_ADMIN_BANNER, WEAK_SIGN_IN_WORDS } = await import(
  '../components/shell/admin-gate'
)

beforeEach(() => vi.clearAllMocks())

async function gate(status: string, testOnly = false) {
  vi.mocked(adminSessionStatus).mockResolvedValue(status as never)
  vi.mocked(requireAdmin).mockResolvedValue(whoami({ testOnly }) as never)
  return AdminGate({ children: <p>the page</p> })
}

describe('AdminGate', () => {
  it('shows an admin the page, and a test admin what it may not do', async () => {
    render(await gate('ok'))
    expect(screen.getByText('the page')).toBeInTheDocument()
    expect(screen.queryByRole('note')).toBeNull()
    render(await gate('ok', true))
    expect(screen.getByRole('note')).toHaveTextContent(TEST_ADMIN_BANNER)
  })

  it('explains a sign-in on an unlinked device, or a weak one, and never shows the page', async () => {
    const { unmount } = render(await gate('factor_mismatch'))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      "can't open with this sign-in",
    )
    expect(screen.getByText(FACTOR_MISMATCH_WORDS)).toBeInTheDocument()
    expect(screen.queryByText('the page')).toBeNull()
    unmount()
    render(await gate('weak_sign_in'))
    expect(screen.getByText(WEAK_SIGN_IN_WORDS)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('is a 404 to anyone else', async () => {
    expect(await navigation(gate('not_admin'))).toBe('NOT_FOUND')
    expect(await navigation(gate('needs_code'))).toBe('NOT_FOUND')
  })
})
