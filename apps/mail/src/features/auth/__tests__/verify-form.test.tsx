import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { verifySecondFactor } from '../actions/two-factor'
import { VerifyForm } from '../components/verify-form'

vi.mock('../actions/two-factor', () => ({ verifySecondFactor: vi.fn() }))

const answer = (result: unknown) =>
  vi.mocked(verifySecondFactor as unknown as () => Promise<unknown>).mockResolvedValue(result)

beforeEach(() => vi.clearAllMocks())

async function enter(code: string) {
  const user = userEvent.setup()
  await user.type(screen.getByRole('textbox', { name: '6-digit code' }), code)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
}

describe('VerifyForm', () => {
  it('puts the cursor straight in the code field and says where the code comes from', () => {
    render(<VerifyForm />)
    const code = screen.getByRole('textbox', { name: '6-digit code' })
    expect(code).toHaveFocus()
    expect(code).toHaveAccessibleDescription(/Open your authenticator app/)
  })

  it('checks the code and carries the destination along', async () => {
    answer({ data: undefined })
    render(<VerifyForm next="/app/settings" />)

    await enter('123 456')

    expect(verifySecondFactor).toHaveBeenCalledWith({ code: '123 456', next: '/app/settings' })
  })

  it('explains a wrong code', async () => {
    answer({ data: { error: "That code didn't work." } })
    render(<VerifyForm />)

    await enter('000000')

    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work.")
  })

  it('shows an unexpected failure', async () => {
    answer({ serverError: 'Please sign in to continue.' })
    render(<VerifyForm />)

    await enter('123456')

    expect(await screen.findByRole('alert')).toHaveTextContent('Please sign in to continue.')
  })

  it('replaces the hint with what is wrong with the code', async () => {
    answer({ validationErrors: { code: { _errors: ['Enter the 6-digit code from your app'] } } })
    render(<VerifyForm />)

    await enter('12')

    const code = screen.getByRole('textbox', { name: '6-digit code' })
    expect(await screen.findByText('Enter the 6-digit code from your app')).toBeInTheDocument()
    expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(code).toHaveAccessibleDescription('Enter the 6-digit code from your app')
  })

  it('shows that the code is being checked', async () => {
    vi.mocked(verifySecondFactor as unknown as () => Promise<unknown>).mockReturnValue(
      new Promise(() => {}),
    )
    render(<VerifyForm />)

    await enter('123456')

    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled()
  })
})
