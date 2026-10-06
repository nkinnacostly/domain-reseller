import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completePasswordReset } from '../actions/password'
import { requestPasswordReset } from '../actions/session'
import { ForgotPasswordForm, ResetPasswordForm } from '../components/recovery-forms'

vi.mock('../actions/session', () => ({ requestPasswordReset: vi.fn() }))
vi.mock('../actions/password', () => ({ completePasswordReset: vi.fn() }))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

beforeEach(() => vi.clearAllMocks())

describe('ForgotPasswordForm', () => {
  async function ask(email = 'ada@example.com') {
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Email' }), email)
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))
  }

  it('asks for a reset link for the address typed', async () => {
    answer(requestPasswordReset, { data: { sentTo: 'ada@example.com' } })
    render(<ForgotPasswordForm />)

    await ask()

    expect(requestPasswordReset).toHaveBeenCalledWith({ email: 'ada@example.com' })
  })

  it('confirms the request without revealing whether the account exists', async () => {
    answer(requestPasswordReset, { data: { sentTo: 'ada@example.com' } })
    render(<ForgotPasswordForm />)

    await ask()

    expect(await screen.findByRole('status')).toHaveTextContent(
      "If ada@example.com has an account, we've sent a link to reset the password.",
    )
    expect(screen.queryByRole('form', { name: 'Reset your password' })).not.toBeInTheDocument()
  })

  it.each([['expired', /expired or was already used/]])(
    'explains why a %s reset link did not work',
    (error, text) => {
      render(<ForgotPasswordForm error={error} />)
      expect(screen.getByRole('alert')).toHaveTextContent(text)
    },
  )

  it('says nothing about an error code it does not know', () => {
    render(<ForgotPasswordForm error="made-up" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports a rate limit', async () => {
    answer(requestPasswordReset, {
      data: { error: 'Wait a few minutes before asking for another.' },
    })
    render(<ForgotPasswordForm />)

    await ask()

    expect(await screen.findByRole('alert')).toHaveTextContent('Wait a few minutes')
  })

  it('marks an invalid address', async () => {
    answer(requestPasswordReset, {
      validationErrors: { email: { _errors: ['Enter a valid email address'] } },
    })
    render(<ForgotPasswordForm />)

    await ask('nope')

    const email = screen.getByRole('textbox', { name: 'Email' })
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAccessibleDescription('Enter a valid email address')
  })

  it('shows that the link is being sent', async () => {
    hang(requestPasswordReset)
    render(<ForgotPasswordForm />)

    await ask()

    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled()
  })
})

describe('ResetPasswordForm', () => {
  async function choose(password: string, confirm: string) {
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('New password'), password)
    await user.type(screen.getByLabelText('Type it again'), confirm)
    await user.click(screen.getByRole('button', { name: 'Save new password' }))
  }

  it('saves the new password typed twice', async () => {
    answer(completePasswordReset, { data: undefined })
    render(<ResetPasswordForm />)

    await choose('brand-new-pass', 'brand-new-pass')

    expect(completePasswordReset).toHaveBeenCalledWith({
      password: 'brand-new-pass',
      confirm: 'brand-new-pass',
    })
  })

  it('states the length rule up front', () => {
    render(<ResetPasswordForm />)
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(
      'At least 10 characters.',
    )
  })

  it('explains a refused reset', async () => {
    answer(completePasswordReset, {
      data: { error: 'Open the reset link from your email to set a new password here.' },
    })
    render(<ResetPasswordForm />)

    await choose('brand-new-pass', 'brand-new-pass')

    expect(await screen.findByRole('alert')).toHaveTextContent('Open the reset link')
  })

  it('shows a signed-out or unexpected failure', async () => {
    answer(completePasswordReset, { serverError: 'Please sign in to continue.' })
    render(<ResetPasswordForm />)

    await choose('brand-new-pass', 'brand-new-pass')

    expect(await screen.findByRole('alert')).toHaveTextContent('Please sign in to continue.')
  })

  it('points at the field that is wrong', async () => {
    answer(completePasswordReset, {
      validationErrors: {
        password: { _errors: ['Use at least 10 characters'] },
        confirm: { _errors: ["The passwords don't match"] },
      },
    })
    render(<ResetPasswordForm />)

    await choose('short', 'shorter')

    expect(await screen.findByText("The passwords don't match")).toBeInTheDocument()
    expect(screen.getByLabelText('Type it again')).toHaveAccessibleDescription(
      "The passwords don't match",
    )
    expect(screen.getByLabelText('Type it again')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(
      'Use at least 10 characters',
    )
  })

  it('shows that the password is being saved', async () => {
    hang(completePasswordReset)
    render(<ResetPasswordForm />)

    await choose('brand-new-pass', 'brand-new-pass')

    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
  })
})
