import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signOut } from '../actions/session'
import { SignOutButton } from '../components/sign-out-button'

vi.mock('../actions/session', () => ({ signOut: vi.fn() }))

const signOutMock = vi.mocked(signOut as unknown as () => Promise<unknown>)

beforeEach(() => vi.clearAllMocks())

describe('SignOutButton', () => {
  it('signs out when pressed', async () => {
    signOutMock.mockResolvedValue({ data: undefined })
    const user = userEvent.setup()
    render(<SignOutButton />)

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('shows that it is signing out and cannot be pressed twice', async () => {
    signOutMock.mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    render(<SignOutButton variant="menu" />)

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Signing out…' })).toBeDisabled()
  })

  it('reads as part of a sentence in its link form', () => {
    render(<SignOutButton variant="link" />)
    expect(screen.getByRole('button', { name: 'sign out' })).toBeEnabled()
  })
})
