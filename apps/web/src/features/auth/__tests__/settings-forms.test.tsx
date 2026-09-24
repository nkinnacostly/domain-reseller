import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changePassword } from '../actions/password'
import { updateProfile } from '../actions/profile'
import { ChangePasswordForm, ProfileForm } from '../components/settings-forms'

vi.mock('../actions/password', () => ({ changePassword: vi.fn() }))
vi.mock('../actions/profile', () => ({ updateProfile: vi.fn() }))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

beforeEach(() => vi.clearAllMocks())

describe('ProfileForm', () => {
  const account = { email: 'ada@example.com', fullName: 'Ada Okafor', phone: '+234 803 123 4567' }

  it('shows the sign-in address as read-only, with why it matters', () => {
    render(<ProfileForm {...account} />)
    const email = screen.getByRole('textbox', { name: 'Email' })
    expect(email).toHaveValue('ada@example.com')
    expect(email).toHaveAttribute('readonly')
    expect(email).toHaveAccessibleDescription(/where sign-in and password reset links go/)
  })

  it('starts from the saved name and phone', () => {
    render(<ProfileForm {...account} />)
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Ada Okafor')
    expect(screen.getByRole('textbox', { name: 'Phone (optional)' })).toHaveValue(
      '+234 803 123 4567',
    )
  })

  it('saves the edited name and phone, and says so', async () => {
    answer(updateProfile, { data: { ok: true } })
    const user = userEvent.setup()
    render(<ProfileForm {...account} phone="" />)

    const name = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Ada O.')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))

    expect(updateProfile).toHaveBeenCalledWith({ fullName: 'Ada O.', phone: '' })
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
  })

  it('reports a failed save', async () => {
    answer(updateProfile, { data: { error: 'Something went wrong on our side.' } })
    const user = userEvent.setup()
    render(<ProfileForm {...account} />)

    await user.click(screen.getByRole('button', { name: 'Save profile' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.')
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
  })

  it('puts each validation message on its field, replacing the phone hint', async () => {
    answer(updateProfile, {
      validationErrors: {
        fullName: { _errors: ['Enter your name'] },
        phone: { _errors: ['Enter a phone number, for example +234 803 123 4567'] },
      },
    })
    const user = userEvent.setup()
    render(<ProfileForm {...account} />)

    await user.click(screen.getByRole('button', { name: 'Save profile' }))

    const name = screen.getByRole('textbox', { name: 'Name' })
    const phone = screen.getByRole('textbox', { name: 'Phone (optional)' })
    expect(await screen.findByText('Enter your name')).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('Enter your name')
    expect(phone).toHaveAccessibleDescription(/Enter a phone number/)
    expect(screen.queryByText(/renewal reminders by SMS/)).not.toBeInTheDocument()
  })

  it('shows that the profile is being saved', async () => {
    hang(updateProfile)
    const user = userEvent.setup()
    render(<ProfileForm {...account} />)

    await user.click(screen.getByRole('button', { name: 'Save profile' }))

    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
  })
})

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
