import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from './form-parts'

describe('Field', () => {
  it('labels its input so the field is reachable by name', () => {
    render(
      <Field id="email" label="Email">
        <input id="email" />
      </Field>,
    )
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeInTheDocument()
  })

  it('shows the hint while the field is valid', () => {
    render(
      <Field id="pw" label="Password" hint="At least 10 characters.">
        <input id="pw" />
      </Field>,
    )
    expect(screen.getByText('At least 10 characters.')).toHaveAttribute('id', 'pw-hint')
  })

  it('replaces the hint with the error once there is one', () => {
    render(
      <Field id="pw" label="Password" hint="At least 10 characters." error="Too short">
        <input id="pw" />
      </Field>,
    )
    expect(screen.queryByText('At least 10 characters.')).not.toBeInTheDocument()
    expect(screen.getByText('Too short')).toHaveAttribute('id', 'pw-error')
  })

  it('puts a companion link beside the label', () => {
    render(
      <Field id="pw" label="Password" action={<a href="/forgot-password">Forgot password?</a>}>
        <input id="pw" />
      </Field>,
    )
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })
})

describe('describedBy', () => {
  it('points a screen reader at the error before anything else', () => {
    expect(describedBy('email', 'Required', 'hint')).toBe('email-error')
  })

  it('points at the hint when the field is valid', () => {
    expect(describedBy('email', undefined, 'hint')).toBe('email-hint')
  })

  it('describes nothing when there is neither', () => {
    expect(describedBy('email')).toBeUndefined()
  })
})

describe('fieldError', () => {
  it('reads the first message for a field from formatted validation errors', () => {
    const errors = { email: { _errors: ['Enter a valid email address', 'second'] } }
    expect(fieldError(errors, 'email')).toBe('Enter a valid email address')
  })

  it('is empty for a field with no errors, or no errors at all', () => {
    expect(fieldError({ email: { _errors: ['x'] } }, 'password')).toBeUndefined()
    expect(fieldError(undefined, 'email')).toBeUndefined()
    expect(fieldError({ email: {} }, 'email')).toBeUndefined()
  })
})

describe('FormMessage', () => {
  it('announces an error as an alert', () => {
    render(<FormMessage tone="error">Wrong password</FormMessage>)
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong password')
  })

  it('announces success politely, as a status', () => {
    render(
      <FormMessage tone="success" className="extra">
        Saved.
      </FormMessage>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Saved.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('SubmitButton', () => {
  it('submits the form with its label while idle', () => {
    render(
      <SubmitButton pending={false} pendingLabel="Saving…">
        Save
      </SubmitButton>,
    )
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-busy')
  })

  it('says what is happening and cannot be pressed twice while pending', () => {
    render(
      <SubmitButton pending pendingLabel="Saving…" variant="secondary">
        Save
      </SubmitButton>,
    )
    const button = screen.getByRole('button', { name: 'Saving…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('Save')).not.toBeInTheDocument()
  })
})

describe('onSubmitWith', () => {
  it('hands over what was typed without navigating or clearing the form', async () => {
    const user = userEvent.setup()
    const handle = vi.fn()
    render(
      <form aria-label="Sign in" onSubmit={onSubmitWith(handle)}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" className={inputClass} />
        <button type="submit">Go</button>
      </form>,
    )

    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Go' }))

    expect(handle).toHaveBeenCalledTimes(1)
    const form = handle.mock.calls[0]?.[0] as FormData
    expect(form.get('email')).toBe('ada@example.com')
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@example.com')
  })
})
