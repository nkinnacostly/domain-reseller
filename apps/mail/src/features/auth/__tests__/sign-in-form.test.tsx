import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signIn } from '../actions/session'
import { SignInForm } from '../components/sign-in-form'

vi.mock('../actions/session', () => ({ signIn: vi.fn() }))

/** What the server action hands back to the form. */
const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

beforeEach(() => vi.clearAllMocks())

async function signInWith(email: string, password: string) {
  const user = userEvent.setup()
  const form = screen.getByRole('form', { name: 'Sign in' })
  await user.type(within(form).getByRole('textbox', { name: 'Email' }), email)
  await user.type(within(form).getByLabelText('Password'), password)
  await user.click(within(form).getByRole('button', { name: 'Sign in' }))
  return user
}

describe('SignInForm — password', () => {
  it('sends the email, password and destination to the sign-in action', async () => {
    answer(signIn, { data: undefined })
    render(<SignInForm next="/app/settings" />)

    await signInWith('ada@example.com', 'correct horse')

    expect(signIn).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'correct horse',
      next: '/app/settings',
    })
  })

  it('explains a wrong password and keeps what was typed', async () => {
    answer(signIn, { data: { error: "That email and password don't match an account." } })
    render(<SignInForm />)

    await signInWith('ada@example.com', 'wrong')

    expect(await screen.findByRole('alert')).toHaveTextContent("don't match an account")
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@example.com')
  })

  it('shows an unexpected server failure', async () => {
    answer(signIn, { serverError: 'Something went wrong on our end. Please try again.' })
    render(<SignInForm />)

    await signInWith('ada@example.com', 'pw')

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our end')
  })

  it('marks each invalid field and reads its message to screen readers', async () => {
    answer(signIn, {
      validationErrors: {
        email: { _errors: ['Enter a valid email address'] },
        password: { _errors: ['Enter your password'] },
      },
    })
    render(<SignInForm />)

    await signInWith('nope', 'x')

    const email = screen.getByRole('textbox', { name: 'Email' })
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email).toHaveAccessibleDescription('Enter a valid email address')
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password')
  })

  it('shows that it is working and cannot be pressed twice', async () => {
    hang(signIn)
    render(<SignInForm />)

    await signInWith('ada@example.com', 'pw')

    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled()
  })

  it('offers a way back in for a forgotten password', () => {
    render(<SignInForm />)
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })
})

describe('SignInForm — notices from an email link', () => {
  it('confirms a verified email as good news', () => {
    render(<SignInForm notice="confirmed" />)
    expect(screen.getByRole('status')).toHaveTextContent('Your email is confirmed')
  })

  it.each([
    ['expired', /expired or was already used/],
    ['device', /did not finish in this browser/],
  ])('explains a %s link as a problem with a way forward', (notice, text) => {
    render(<SignInForm notice={notice} />)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('ignores a notice it does not know', () => {
    render(<SignInForm notice="made-up" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
