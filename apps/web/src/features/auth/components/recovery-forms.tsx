'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { PasswordInput } from '@/components/common/password-input'
import { completePasswordReset } from '../actions/password'
import { requestPasswordReset } from '../actions/session'

const LINK_ERRORS: Record<string, string> = {
  expired: 'That reset link has expired or was already used. Ask for a new one below.',
  device:
    'Reset links only work in the browser you asked from. Ask for a new link here, then open it on this device.',
}

export function ForgotPasswordForm({ error }: { error?: string }) {
  const id = useId()
  const request = useAction(requestPasswordReset)
  const errors = request.result.validationErrors
  const data = request.result.data
  const sentTo = data && 'sentTo' in data ? data.sentTo : null

  if (sentTo) {
    return (
      <FormMessage tone="success">
        If <strong className="font-medium">{sentTo}</strong> has an account, we've sent a link to
        reset the password. It expires in an hour.
      </FormMessage>
    )
  }

  const linkError = error ? LINK_ERRORS[error] : undefined

  return (
    <form
      aria-label="Reset your password"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) => request.execute({ email: String(form.get('email') ?? '') }))}
    >
      {linkError ? <FormMessage tone="error">{linkError}</FormMessage> : null}
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}

      <Field id={`${id}-email`} label="Email" error={fieldError(errors, 'email')}>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          aria-invalid={fieldError(errors, 'email') ? true : undefined}
          aria-describedby={describedBy(`${id}-email`, fieldError(errors, 'email'))}
          className={inputClass}
        />
      </Field>
      <SubmitButton pending={request.isPending} pendingLabel="Sending…">
        Email me a reset link
      </SubmitButton>
    </form>
  )
}

export function ResetPasswordForm() {
  const id = useId()
  const reset = useAction(completePasswordReset)
  const errors = reset.result.validationErrors
  const data = reset.result.data

  return (
    <form
      aria-label="Choose a new password"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) =>
        reset.execute({
          password: String(form.get('password') ?? ''),
          confirm: String(form.get('confirm') ?? ''),
        }),
      )}
    >
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}
      {reset.result.serverError ? (
        <FormMessage tone="error">{reset.result.serverError}</FormMessage>
      ) : null}

      <Field
        id={`${id}-password`}
        label="New password"
        error={fieldError(errors, 'password')}
        hint="At least 10 characters."
      >
        <PasswordInput
          id={`${id}-password`}
          name="password"
          autoComplete="new-password"
          required
          aria-invalid={fieldError(errors, 'password') ? true : undefined}
          aria-describedby={describedBy(`${id}-password`, fieldError(errors, 'password'), 'hint')}
        />
      </Field>
      <Field id={`${id}-confirm`} label="Type it again" error={fieldError(errors, 'confirm')}>
        <PasswordInput
          id={`${id}-confirm`}
          name="confirm"
          autoComplete="new-password"
          required
          aria-invalid={fieldError(errors, 'confirm') ? true : undefined}
          aria-describedby={describedBy(`${id}-confirm`, fieldError(errors, 'confirm'))}
        />
      </Field>
      <SubmitButton pending={reset.isPending} pendingLabel="Saving…">
        Save new password
      </SubmitButton>
    </form>
  )
}
