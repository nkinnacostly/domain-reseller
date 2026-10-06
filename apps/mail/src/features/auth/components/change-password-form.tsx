'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId, useRef } from 'react'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  onSubmitWith,
  SubmitButton,
} from '@/components/common/form-parts'
import { PasswordInput } from '@/components/common/password-input'
import { changePassword } from '../actions/password'

/** The shop's password form: one password for Mail and the shop (MAIL-SPEC M5). */
export function ChangePasswordForm() {
  const id = useId()
  const formRef = useRef<HTMLFormElement>(null)
  // Clear the fields only once the change has gone through — never after an
  // error, or a mistyped current password wipes the new one too.
  const change = useAction(changePassword, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) formRef.current?.reset()
    },
  })
  const errors = change.result.validationErrors
  const data = change.result.data

  return (
    <form
      ref={formRef}
      aria-label="Change password"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) =>
        change.execute({
          current: String(form.get('current') ?? ''),
          password: String(form.get('password') ?? ''),
          confirm: String(form.get('confirm') ?? ''),
        }),
      )}
    >
      {data && 'ok' in data ? (
        <FormMessage tone="success">
          Password changed. Every other device has been signed out.
        </FormMessage>
      ) : null}
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}

      <Field id={`${id}-current`} label="Current password" error={fieldError(errors, 'current')}>
        <PasswordInput
          id={`${id}-current`}
          name="current"
          autoComplete="current-password"
          aria-invalid={fieldError(errors, 'current') ? true : undefined}
          aria-describedby={describedBy(`${id}-current`, fieldError(errors, 'current'))}
        />
      </Field>
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
          aria-invalid={fieldError(errors, 'password') ? true : undefined}
          aria-describedby={describedBy(`${id}-password`, fieldError(errors, 'password'), 'hint')}
        />
      </Field>
      <Field id={`${id}-confirm`} label="Type it again" error={fieldError(errors, 'confirm')}>
        <PasswordInput
          id={`${id}-confirm`}
          name="confirm"
          autoComplete="new-password"
          aria-invalid={fieldError(errors, 'confirm') ? true : undefined}
          aria-describedby={describedBy(`${id}-confirm`, fieldError(errors, 'confirm'))}
        />
      </Field>
      <SubmitButton pending={change.isPending} pendingLabel="Changing…" className="sm:w-auto">
        Change password
      </SubmitButton>
    </form>
  )
}
