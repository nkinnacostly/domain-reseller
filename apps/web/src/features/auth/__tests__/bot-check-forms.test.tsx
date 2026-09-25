import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTurnstile, uninstallTurnstile } from '../../../../tests/mocks/turnstile'

// The server actions are the forms' network boundary.
vi.mock('../actions/session', () => ({
  signUp: vi.fn(),
  resendConfirmation: vi.fn(),
  signIn: vi.fn(),
  sendMagicLink: vi.fn(),
  requestPasswordReset: vi.fn(),
}))
vi.mock('../actions/password', () => ({ completePasswordReset: vi.fn() }))

const REFUSED = { data: { error: "We couldn't confirm you're a person. Try again." } }

/** env.ts reads the site key once, at import — so the forms are loaded fresh. */
async function load() {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key')
  const actions = await import('../actions/session')
  const { SignUpForm } = await import('../components/sign-up-form')
  const { SignInForm } = await import('../components/sign-in-form')
  const { ForgotPasswordForm } = await import('../components/recovery-forms')
  const cloudflare = installTurnstile()
  const answer = (fn: unknown, result: unknown) =>
    vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
  return { ...actions, SignUpForm, SignInForm, ForgotPasswordForm, cloudflare, answer }
}

async function drawn(cloudflare: ReturnType<typeof installTurnstile>, times = 1) {
  await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalledTimes(times))
}

beforeEach(() => uninstallTurnstile())
afterEach(() => vi.unstubAllEnvs())

describe('SignUpForm with Turnstile (SEC-9)', () => {
  async function fillIn() {
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ada Okafor')
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'long-enough-1')
    return user
  }

  it('shows why a refused sign-up failed, keeps the form, and asks for a fresh token', async () => {
    const { SignUpForm, signUp, cloudflare, answer } = await load()
    answer(signUp, REFUSED)
    render(<SignUpForm />)
    await drawn(cloudflare)
    cloudflare.solve('token-1')

    const user = await fillIn()
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm you're a person",
    )
    expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveValue('Ada Okafor')
    expect(cloudflare.api.reset).toHaveBeenCalledWith('widget-1')
  })

  it('sends the widget’s token with the form', async () => {
    const { SignUpForm, signUp, cloudflare, answer } = await load()
    answer(signUp, { data: { error: 'x' } })
    render(<SignUpForm next="/cart" />)
    await drawn(cloudflare)
    expect(cloudflare.options().action).toBe('sign-up')
    cloudflare.solve('token-1')

    const user = await fillIn()
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(signUp).toHaveBeenCalledWith({
      fullName: 'Ada Okafor',
      email: 'ada@example.com',
      password: 'long-enough-1',
      next: '/cart',
      turnstileToken: 'token-1',
    })
  })

  it('sends a token of its own when asking for the link again', async () => {
    const { SignUpForm, signUp, resendConfirmation, cloudflare, answer } = await load()
    answer(signUp, { data: { sentTo: 'ada@example.com' } })
    answer(resendConfirmation, REFUSED)
    render(<SignUpForm />)
    await drawn(cloudflare)
    cloudflare.solve('token-1')
    const user = await fillIn()
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await screen.findByText('Check your email')

    await drawn(cloudflare, 2)
    expect(cloudflare.options().action).toBe('resend-confirmation')
    cloudflare.solve('token-2')
    await user.click(screen.getByRole('button', { name: 'Send the link again' }))

    expect(resendConfirmation).toHaveBeenCalledWith({
      email: 'ada@example.com',
      next: undefined,
      turnstileToken: 'token-2',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm you're a person",
    )
    expect(cloudflare.api.reset).toHaveBeenCalledWith('widget-2')
  })
})

describe('SignInForm with Turnstile (SEC-9)', () => {
  it('asks nothing of a password sign-in, which sends no email', async () => {
    const { SignInForm, cloudflare } = await load()
    render(<SignInForm />)

    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument()
    expect(cloudflare.api.render).not.toHaveBeenCalled()
  })

  it('sends a token with a sign-in link request, and asks for a fresh one after a refusal', async () => {
    const { SignInForm, sendMagicLink, cloudflare, answer } = await load()
    answer(sendMagicLink, REFUSED)
    const user = userEvent.setup()
    render(<SignInForm next="/app/domains" />)

    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link instead' }))
    await drawn(cloudflare)
    expect(cloudflare.options().action).toBe('sign-in-link')
    cloudflare.solve('token-1')
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a link' }))

    expect(sendMagicLink).toHaveBeenCalledWith({
      email: 'ada@example.com',
      next: '/app/domains',
      turnstileToken: 'token-1',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm you're a person",
    )
    expect(cloudflare.api.reset).toHaveBeenCalledWith('widget-1')
  })
})

describe('ForgotPasswordForm with Turnstile (SEC-9)', () => {
  it('sends a token with the reset request, and asks for a fresh one after a refusal', async () => {
    const { ForgotPasswordForm, requestPasswordReset, cloudflare, answer } = await load()
    answer(requestPasswordReset, REFUSED)
    const user = userEvent.setup()
    render(<ForgotPasswordForm />)
    await drawn(cloudflare)
    expect(cloudflare.options().action).toBe('password-reset')
    cloudflare.solve('token-1')

    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: 'ada@example.com',
      turnstileToken: 'token-1',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm you're a person",
    )
    expect(cloudflare.api.reset).toHaveBeenCalledWith('widget-1')
  })
})
