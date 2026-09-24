import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmTotpEnrollment, disableTwoFactor, startTotpEnrollment } from '../actions/two-factor'
import { TwoFactorPanel } from '../components/two-factor-panel'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }))
vi.mock('../actions/two-factor', () => ({
  startTotpEnrollment: vi.fn(),
  confirmTotpEnrollment: vi.fn(),
  disableTwoFactor: vi.fn(),
}))

const answer = (fn: unknown, result: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockResolvedValue(result)
const hang = (fn: unknown) =>
  vi.mocked(fn as () => Promise<unknown>).mockReturnValue(new Promise(() => {}))

beforeEach(() => vi.clearAllMocks())

describe('TwoFactorPanel — when it is on', () => {
  async function turnOff() {
    const user = userEvent.setup()
    render(<TwoFactorPanel factorId="factor-1" />)
    await user.click(screen.getByRole('button', { name: 'Turn off two-factor' }))
  }

  it('says it is on and what that means', () => {
    render(<TwoFactorPanel factorId="factor-1" />)
    expect(screen.getByText(/Signing in needs a code from your authenticator app/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Turn on two-factor' })).not.toBeInTheDocument()
  })

  it('turns off the factor on file and refreshes the page', async () => {
    answer(disableTwoFactor, { data: { ok: true } })

    await turnOff()

    expect(disableTwoFactor).toHaveBeenCalledWith({ factorId: 'factor-1' })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(push).not.toHaveBeenCalled()
  })

  it('sends the person for a fresh code first, then back to this section', async () => {
    answer(disableTwoFactor, { data: { verify: true } })

    await turnOff()

    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith('/verify?next=/app/settings%23two-factor'),
    )
    expect(refresh).not.toHaveBeenCalled()
  })

  it('explains why it could not be turned off, and stays put', async () => {
    answer(disableTwoFactor, {
      data: { error: 'For your security, changes like this are paused for 24 hours.' },
    })

    await turnOff()

    expect(await screen.findByRole('alert')).toHaveTextContent('paused for 24 hours')
    expect(push).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('shows that it is turning off', async () => {
    hang(disableTwoFactor)

    await turnOff()

    expect(await screen.findByRole('button', { name: 'Turning off…' })).toBeDisabled()
  })
})

describe('TwoFactorPanel — turning it on', () => {
  const setup = {
    factorId: 'factor-new',
    qrCode: 'data:image/svg+xml;utf8,<svg/>',
    secret: 'JBSWY3DPEHPK3PXPAB',
  }

  async function start() {
    const user = userEvent.setup()
    render(<TwoFactorPanel factorId={null} />)
    await user.click(screen.getByRole('button', { name: 'Turn on two-factor' }))
    return user
  }

  async function started() {
    answer(startTotpEnrollment, { data: setup })
    const user = await start()
    await screen.findByRole('img', { name: /QR code/ })
    return user
  }

  it('says it is off and why it is worth turning on', () => {
    render(<TwoFactorPanel factorId={null} />)
    expect(screen.getByText(/still can't sign in or move your domains/)).toBeVisible()
  })

  it('shows the QR code and a key grouped in fours for typing by hand', async () => {
    await started()

    expect(startTotpEnrollment).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('img', {
        name: 'QR code for adding this account to your authenticator app',
      }),
    ).toHaveAttribute('src', setup.qrCode)
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP AB')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Confirm two-factor' })).toBeInTheDocument()
  })

  it('explains why set-up could not start', async () => {
    answer(startTotpEnrollment, {
      data: { error: 'Sign in with your password to change two-factor settings.' },
    })

    await start()

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in with your password')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows that set-up is starting', async () => {
    hang(startTotpEnrollment)

    await start()

    expect(await screen.findByRole('button', { name: 'Setting up…' })).toBeDisabled()
  })

  it('confirms the first code against the new factor and refreshes the page', async () => {
    const user = await started()
    answer(confirmTotpEnrollment, { data: { ok: true } })

    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '123 456')
    await user.click(screen.getByRole('button', { name: 'Confirm and turn on' }))

    expect(confirmTotpEnrollment).toHaveBeenCalledWith({ factorId: 'factor-new', code: '123 456' })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('explains a wrong first code', async () => {
    const user = await started()
    answer(confirmTotpEnrollment, { data: { error: "That code didn't work." } })

    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '000000')
    await user.click(screen.getByRole('button', { name: 'Confirm and turn on' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work.")
  })

  it('marks a malformed code on the field', async () => {
    const user = await started()
    answer(confirmTotpEnrollment, {
      validationErrors: { code: { _errors: ['Enter the 6-digit code from your app'] } },
    })

    await user.click(screen.getByRole('button', { name: 'Confirm and turn on' }))

    const code = screen.getByRole('textbox', { name: '6-digit code' })
    expect(await screen.findByText('Enter the 6-digit code from your app')).toBeInTheDocument()
    expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(code).toHaveAccessibleDescription('Enter the 6-digit code from your app')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('shows that the code is being checked', async () => {
    const user = await started()
    hang(confirmTotpEnrollment)

    await user.type(screen.getByRole('textbox', { name: '6-digit code' }), '123456')
    await user.click(screen.getByRole('button', { name: 'Confirm and turn on' }))

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled()
  })
})
