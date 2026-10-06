import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { PasswordInput } from './password-input'

function renderField() {
  render(
    <>
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" name="password" autoComplete="current-password" />
    </>,
  )
  return screen.getByLabelText('Password')
}

describe('PasswordInput', () => {
  it('hides what is typed by default', () => {
    const input = renderField()
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('name', 'password')
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('reveals the password on request and hides it again', async () => {
    const user = userEvent.setup()
    const input = renderField()
    await user.type(input, 'correct horse')

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveValue('correct horse')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(input).toHaveAttribute('type', 'password')
  })

  it('does not submit the surrounding form when toggled', async () => {
    const user = userEvent.setup()
    let submitted = false
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submitted = true
        }}
      >
        <PasswordInput aria-label="Password" />
      </form>,
    )
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(submitted).toBe(false)
  })
})
