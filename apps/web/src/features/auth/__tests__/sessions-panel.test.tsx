import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { revokeSession, signOutOtherSessions } from '../actions/sessions'
import { SessionsPanel, type SessionView } from '../components/sessions-panel'
import { SessionsSection, SessionsSkeleton } from '../components/sessions-section'
import { getSessions } from '../queries/sessions'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
// The server actions and the query are the boundary for these components.
vi.mock('../actions/sessions', () => ({ revokeSession: vi.fn(), signOutOtherSessions: vi.fn() }))
vi.mock('../queries/sessions', () => ({ getSessions: vi.fn() }))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)

const THIS: SessionView = {
  id: 'this',
  device: 'Chrome on macOS',
  ip: '105.112.3.4',
  signedIn: '23 Sept 2026',
  lastSeen: 'in the last hour',
  isCurrent: true,
}
const PHONE: SessionView = {
  id: '00000000-0000-4000-8000-000000000002',
  device: 'Safari on iOS',
  ip: null,
  signedIn: '1 Sept 2026',
  lastSeen: '3 days ago',
  isCurrent: false,
}

const list = () => within(screen.getByRole('list', { name: 'Signed-in devices' }))

beforeEach(() => vi.clearAllMocks())

describe('SessionsPanel — when the list cannot be read', () => {
  it('says so, and still offers to sign every other device out', () => {
    render(<SessionsPanel sessions={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load your devices just now.")
    expect(screen.getByRole('button', { name: 'Sign out of all other devices' })).toBeEnabled()
  })
})

describe('SessionsPanel — the list (FR-A5)', () => {
  it('names this device, and offers no way to sign it out from here', () => {
    render(<SessionsPanel sessions={[THIS]} />)

    const row = list().getByRole('listitem')
    expect(row).toHaveTextContent('Chrome on macOS')
    expect(row).toHaveTextContent('This device')
    expect(row).toHaveTextContent('IP 105.112.3.4 · Signed in 23 Sept 2026 · Active now')
    expect(within(row).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('This is the only device signed in.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /all other devices/ })).not.toBeInTheDocument()
  })

  it('shows every other device with when it was last seen, and a way to sign it out', () => {
    render(<SessionsPanel sessions={[THIS, PHONE]} />)

    const phone = list().getAllByRole('listitem')[1] as HTMLElement
    expect(phone).toHaveTextContent('Safari on iOS')
    expect(phone).toHaveTextContent('Signed in 1 Sept 2026 · Last seen 3 days ago')
    expect(phone).not.toHaveTextContent('IP')
    expect(within(phone).getByRole('button', { name: 'Sign out Safari on iOS' })).toBeEnabled()
  })

  it('is honest that a signed-out device can keep working until its token expires', () => {
    render(<SessionsPanel sessions={[THIS, PHONE]} />)
    expect(
      screen.getByText(/A device you sign out can keep working for up to an hour/),
    ).toBeVisible()
  })
})

describe('SessionsPanel — signing one device out', () => {
  async function signOutPhone() {
    const user = userEvent.setup()
    render(<SessionsPanel sessions={[THIS, PHONE]} />)
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iOS' }))
  }

  it('shows a refusal on that device’s row, and leaves the list alone', async () => {
    answer(revokeSession, { data: { error: 'That device was already signed out.' } })
    await signOutPhone()

    const phone = list().getAllByRole('listitem')[1] as HTMLElement
    expect(await within(phone).findByRole('alert')).toHaveTextContent('already signed out')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('shows a server failure the same way', async () => {
    answer(revokeSession, { serverError: 'Please sign in to continue.' })
    await signOutPhone()
    expect(await screen.findByRole('alert')).toHaveTextContent('Please sign in to continue.')
  })

  it('signs out that session only, says so, and reloads the list', async () => {
    answer(revokeSession, { data: { ok: true } })
    await signOutPhone()

    expect(revokeSession).toHaveBeenCalledWith({ sessionId: PHONE.id })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Safari on iOS has been signed out.',
    )
    expect(refresh).toHaveBeenCalled()
  })

  it('shows it is working, so nobody presses twice (S12)', async () => {
    vi.mocked(revokeSession).mockReturnValue(new Promise(() => {}) as never)
    await signOutPhone()
    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled()
  })
})

describe('SessionsPanel — signing out everywhere else', () => {
  async function signOutOthers() {
    const user = userEvent.setup()
    render(<SessionsPanel sessions={[THIS, PHONE]} />)
    await user.click(screen.getByRole('button', { name: 'Sign out of all other devices' }))
  }

  it('shows why it could not', async () => {
    answer(signOutOtherSessions, { data: { error: 'Too many attempts in a short time.' } })
    await signOutOthers()
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('shows a server failure the same way', async () => {
    answer(signOutOtherSessions, { serverError: 'Please sign in to continue.' })
    await signOutOthers()
    expect(await screen.findByRole('alert')).toHaveTextContent('Please sign in to continue.')
  })

  it('signs every other device out, says so, and reloads the list', async () => {
    answer(signOutOtherSessions, { data: { ok: true } })
    await signOutOthers()

    expect(signOutOtherSessions).toHaveBeenCalled()
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Every other device has been signed out.',
    )
    expect(refresh).toHaveBeenCalled()
  })
})

describe('SessionsSection', () => {
  it('puts the dates into words on the server', async () => {
    vi.mocked(getSessions).mockResolvedValue([
      {
        id: 'this',
        device: 'Chrome on macOS',
        ip: null,
        signedInAt: '2026-09-23T09:00:00Z',
        lastActiveAt: new Date().toISOString(),
        isCurrent: true,
      },
      {
        id: PHONE.id,
        device: 'Safari on iOS',
        ip: null,
        signedInAt: '2026-09-01T09:00:00Z',
        lastActiveAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        isCurrent: false,
      },
    ])
    render((await SessionsSection()) as ReactElement)

    expect(list().getAllByRole('listitem')[0]).toHaveTextContent('Signed in 23 Sept 2026')
    expect(list().getAllByRole('listitem')[1]).toHaveTextContent('Last seen 3 hours ago')
  })

  it('passes on a failed read, so the panel can say so', async () => {
    vi.mocked(getSessions).mockResolvedValue(null)
    render((await SessionsSection()) as ReactElement)
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load your devices")
  })

  it('has a placeholder hidden from assistive tech while it loads', () => {
    const { container } = render(<SessionsSkeleton />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })
})
