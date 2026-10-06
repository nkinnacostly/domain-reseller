import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changePassword } from '../actions/password'
import { ChangePasswordForm } from '../components/change-password-form'

vi.mock('../actions/password', () => ({ changePassword: vi.fn() }))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

beforeEach(() => vi.clearAllMocks())

describe('ChangePasswordForm', () => {
  async function change({
    current = 'old-password',
    password = 'brand-new-pass',
    confirm = 'brand-new-pass',
  } = {}) {
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Current password'), current)
    await user.type(screen.getByLabelText('New password'), password)
    await user.type(screen.getByLabelText('Type it again'), confirm)
    await user.click(screen.getByRole('button', { name: 'Change password' }))
  }

  it('sends the current and new passwords', async () => {
    answer(changePassword, { data: { ok: true } })
    render(<ChangePasswordForm />)

    await change()

    expect(changePassword).toHaveBeenCalledWith({
      current: 'old-password',
      password: 'brand-new-pass',
      confirm: 'brand-new-pass',
    })
  })

  it('confirms the change and clears every field', async () => {
    answer(changePassword, { data: { ok: true } })
    render(<ChangePasswordForm />)

    await change()

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Password changed. Every other device has been signed out.',
    )
    expect(screen.getByLabelText('Current password')).toHaveValue('')
    expect(screen.getByLabelText('New password')).toHaveValue('')
    expect(screen.getByLabelText('Type it again')).toHaveValue('')
  })

  it('keeps the new password typed when the current one is wrong', async () => {
    answer(changePassword, { data: { error: "That isn't your current password." } })
    render(<ChangePasswordForm />)

    await change()

    expect(await screen.findByRole('alert')).toHaveTextContent("That isn't your current password.")
    expect(screen.getByLabelText('New password')).toHaveValue('brand-new-pass')
    expect(screen.getByLabelText('Type it again')).toHaveValue('brand-new-pass')
  })

  it('points at the fields that need fixing', async () => {
    answer(changePassword, {
      validationErrors: {
        current: { _errors: ['Enter your current password'] },
        password: { _errors: ['Use at least 10 characters'] },
        confirm: { _errors: ["The passwords don't match"] },
      },
    })
    render(<ChangePasswordForm />)

    await change({ current: 'x', password: 'short', confirm: 'other' })

    expect(await screen.findByText('Enter your current password')).toBeInTheDocument()
    expect(screen.getByLabelText('Current password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Current password')).toHaveAccessibleDescription(
      'Enter your current password',
    )
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(
      'Use at least 10 characters',
    )
    expect(screen.getByLabelText('Type it again')).toHaveAccessibleDescription(
      "The passwords don't match",
    )
    expect(screen.getByLabelText('New password')).toHaveValue('short')
  })

  it('shows that the change is in progress', async () => {
    hang(changePassword)
    render(<ChangePasswordForm />)

    await change()

    expect(await screen.findByRole('button', { name: 'Changing…' })).toBeDisabled()
  })
})
