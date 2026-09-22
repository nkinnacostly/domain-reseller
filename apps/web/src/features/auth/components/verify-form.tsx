'use client'

import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import { verifySecondFactor } from '../actions/two-factor'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from './form-parts'

export function VerifyForm({ next }: { next?: string }) {
  const id = useId()
  const verify = useAction(verifySecondFactor)
  const errors = verify.result.validationErrors
  const data = verify.result.data

  return (
    <form
      aria-label="Two-factor code"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) =>
        verify.execute({ code: String(form.get('code') ?? ''), next }),
      )}
    >
      {data?.error ? <FormMessage tone="error">{data.error}</FormMessage> : null}
      {verify.result.serverError ? (
        <FormMessage tone="error">{verify.result.serverError}</FormMessage>
      ) : null}

      <Field
        id={`${id}-code`}
        label="6-digit code"
        error={fieldError(errors, 'code')}
        hint="Open your authenticator app and enter the code shown for this account."
      >
        <input
          id={`${id}-code`}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          required
          // biome-ignore lint/a11y/noAutofocus: the code is this page's only purpose
          autoFocus
          aria-invalid={fieldError(errors, 'code') ? true : undefined}
          aria-describedby={describedBy(`${id}-code`, fieldError(errors, 'code'), 'hint')}
          className={`${inputClass} text-center text-lg tracking-[0.4em] tabular-nums`}
        />
      </Field>
      <SubmitButton pending={verify.isPending} pendingLabel="Checking…">
        Continue
      </SubmitButton>
    </form>
  )
}
