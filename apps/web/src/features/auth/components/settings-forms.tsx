'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId, useRef } from 'react'
import { changePassword } from '../actions/password'
import { updateProfile } from '../actions/profile'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from './form-parts'
import { PasswordInput } from './password-input'

export function ProfileForm({
  email,
  fullName,
  phone,
}: {
  email: string
  fullName: string
  phone: string
}) {
  const id = useId()
  const save = useAction(updateProfile)
  const errors = save.result.validationErrors
  const data = save.result.data

  return (
    <form
      aria-label="Profile"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) =>
        save.execute({
          fullName: String(form.get('fullName') ?? ''),
          phone: String(form.get('phone') ?? ''),
        }),
      )}
    >
      {data && 'ok' in data ? <FormMessage tone="success">Saved.</FormMessage> : null}
      {data && 'error' in data ? <FormMessage tone="error">{data.error}</FormMessage> : null}

      <Field
        id={`${id}-email`}
        label="Email"
        hint="The address you sign in with and where we send receipts."
      >
        <input
          id={`${id}-email`}
          value={email}
          readOnly
          aria-describedby={`${id}-email-hint`}
          className={`${inputClass} bg-muted/50 text-muted-foreground`}
        />
      </Field>
      <Field id={`${id}-name`} label="Name" error={fieldError(errors, 'fullName')}>
        <input
          id={`${id}-name`}
          name="fullName"
          defaultValue={fullName}
          autoComplete="name"
          aria-invalid={fieldError(errors, 'fullName') ? true : undefined}
          aria-describedby={describedBy(`${id}-name`, fieldError(errors, 'fullName'))}
          className={inputClass}
        />
      </Field>
      <Field
        id={`${id}-phone`}
        label="Phone (optional)"
        error={fieldError(errors, 'phone')}
        hint="For renewal reminders by SMS and WhatsApp."
      >
        <input
          id={`${id}-phone`}
          name="phone"
          type="tel"
          defaultValue={phone}
          autoComplete="tel"
          inputMode="tel"
          placeholder="+234 803 123 4567"
          aria-invalid={fieldError(errors, 'phone') ? true : undefined}
          aria-describedby={describedBy(`${id}-phone`, fieldError(errors, 'phone'), 'hint')}
          className={inputClass}
        />
      </Field>
      <SubmitButton pending={save.isPending} pendingLabel="Saving…" className="sm:w-auto">
        Save profile
      </SubmitButton>
    </form>
  )
}

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
