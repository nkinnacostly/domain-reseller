import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resendConfirmation, signUp } from '../actions/session'
import { SignUpForm } from '../components/sign-up-form'

vi.mock('../actions/session', () => ({ signUp: vi.fn(), resendConfirmation: vi.fn() }))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

beforeEach(() => vi.clearAllMocks())

async function createAccount() {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ada Okafor')
  await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com')
  await user.type(screen.getByLabelText('Password'), 'long-enough-1')
  await user.click(screen.getByRole('button', { name: 'Create account' }))
  return user
}

describe('SignUpForm', () => {
  it('sends the name, email, password and destination to the sign-up action', async () => {
    answer(signUp, { data: { error: 'x' } })
    render(<SignUpForm next="/cart" />)

    await createAccount()

    expect(signUp).toHaveBeenCalledWith({
      fullName: 'Ada Okafor',
      email: 'ada@example.com',
      password: 'long-enough-1',
      next: '/cart',
    })
  })

  it('explains the password rules before anything is typed', () => {
    render(<SignUpForm />)
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(/At least 10 characters/)
  })

  it('links the agreements the person is accepting', () => {
    render(<SignUpForm />)
    expect(screen.getByRole('link', { name: 'registration agreement' })).toHaveAttribute(
      'href',
      '/legal/registration-agreement',
    )
    expect(screen.getByRole('link', { name: 'privacy notice' })).toHaveAttribute(
      'href',
      '/legal/privacy',
    )
  })

  it('explains a refused sign-up and keeps the form', async () => {
    answer(signUp, { data: { error: 'New sign-ups are paused right now.' } })
    render(<SignUpForm />)

    await createAccount()

    expect(await screen.findByRole('alert')).toHaveTextContent('New sign-ups are paused')
    expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveValue('Ada Okafor')
  })

  it('shows an unexpected server failure', async () => {
    answer(signUp, { serverError: 'Something went wrong on our end. Please try again.' })
    render(<SignUpForm />)

    await createAccount()

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our end')
  })

  it('puts each validation message on its field', async () => {
    answer(signUp, {
      validationErrors: {
        fullName: { _errors: ['Enter your name'] },
        email: { _errors: ['Enter a valid email address'] },
        password: { _errors: ['Use at least 10 characters'] },
      },
    })
    render(<SignUpForm />)

    await createAccount()

    expect(await screen.findByText('Enter your name')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveAccessibleDescription(
      'Enter your name',
    )
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true')
    const password = screen.getByLabelText('Password')
    expect(password).toHaveAccessibleDescription('Use at least 10 characters')
    expect(screen.queryByText(/A few unrelated words/)).not.toBeInTheDocument()
  })

  it('shows that the account is being created', async () => {
    hang(signUp)
    render(<SignUpForm />)

    await createAccount()

    expect(await screen.findByRole('button', { name: 'Creating your account…' })).toBeDisabled()
  })
})

describe('SignUpForm — after sign-up', () => {
  async function signedUp(next?: string) {
    answer(signUp, { data: { sentTo: 'ada@example.com' } })
    render(<SignUpForm next={next} />)
    const user = await createAccount()
    await screen.findByText('Check your email')
    return user
  }

  it('tells the person to check their inbox, naming the address', async () => {
    await signedUp()
    expect(screen.getByRole('status')).toHaveTextContent(
      /We sent a confirmation link to ada@example\.com/,
    )
    expect(screen.queryByRole('form', { name: 'Create an account' })).not.toBeInTheDocument()
  })

  it('sends the link again to the same address and destination', async () => {
    const user = await signedUp('/cart')
    answer(resendConfirmation, { data: { sentTo: 'ada@example.com' } })

    await user.click(screen.getByRole('button', { name: 'Send the link again' }))

    expect(await screen.findByText('Sent again.')).toBeInTheDocument()
    expect(resendConfirmation).toHaveBeenCalledWith({ email: 'ada@example.com', next: '/cart' })
  })

  it('explains when the link cannot be sent again yet', async () => {
    const user = await signedUp()
    answer(resendConfirmation, { data: { error: 'Wait a few minutes before asking for another.' } })

    await user.click(screen.getByRole('button', { name: 'Send the link again' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Wait a few minutes')
    expect(screen.queryByText('Sent again.')).not.toBeInTheDocument()
  })

  it('shows that the link is being sent again', async () => {
    const user = await signedUp()
    hang(resendConfirmation)

    await user.click(screen.getByRole('button', { name: 'Send the link again' }))

    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled()
  })
})
