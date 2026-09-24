'use client'

import Link from 'next/link'
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
import { resendConfirmation, signUp } from '../actions/session'

const PASSWORD_HINT = 'At least 10 characters. A few unrelated words is strong and easy to type.'

export function SignUpForm({ next }: { next?: string }) {
  const id = useId()
  const create = useAction(signUp)
  const resend = useAction(resendConfirmation)
  const errors = create.result.validationErrors
  const sentTo =
    create.result.data && 'sentTo' in create.result.data ? create.result.data.sentTo : null

  if (sentTo) {
    const resent = resend.result.data && 'sentTo' in resend.result.data
    const resendError =
      resend.result.data && 'error' in resend.result.data ? resend.result.data.error : null
    return (
      <div className="space-y-5">
        <FormMessage tone="success">
          <p className="font-medium">Check your email</p>
          <p className="mt-1">
            We sent a confirmation link to <strong className="font-medium">{sentTo}</strong>. Open
            it to finish creating your account — it can take a minute to arrive, so check spam too.
          </p>
        </FormMessage>
        {resent ? <FormMessage tone="success">Sent again.</FormMessage> : null}
        {resendError ? <FormMessage tone="error">{resendError}</FormMessage> : null}
        <form onSubmit={onSubmitWith(() => resend.execute({ email: sentTo, next }))}>
          <SubmitButton pending={resend.isPending} pendingLabel="Sending…" variant="secondary">
            Send the link again
          </SubmitButton>
        </form>
      </div>
    )
  }

  return (
    <form
      aria-label="Create an account"
      className="space-y-4"
      noValidate
      onSubmit={onSubmitWith((form) =>
        create.execute({
          fullName: String(form.get('fullName') ?? ''),
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
          next,
        }),
      )}
    >
      {create.result.data && 'error' in create.result.data ? (
        <FormMessage tone="error">{create.result.data.error}</FormMessage>
      ) : null}
      {create.result.serverError ? (
        <FormMessage tone="error">{create.result.serverError}</FormMessage>
      ) : null}

      <Field id={`${id}-name`} label="Your name" error={fieldError(errors, 'fullName')}>
        <input
          id={`${id}-name`}
          name="fullName"
          autoComplete="name"
          required
          aria-invalid={fieldError(errors, 'fullName') ? true : undefined}
          aria-describedby={describedBy(`${id}-name`, fieldError(errors, 'fullName'))}
          className={inputClass}
        />
      </Field>

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

      <Field
        id={`${id}-password`}
        label="Password"
        error={fieldError(errors, 'password')}
        hint={PASSWORD_HINT}
      >
        <PasswordInput
          id={`${id}-password`}
          name="password"
          autoComplete="new-password"
          required
          minLength={10}
          aria-invalid={fieldError(errors, 'password') ? true : undefined}
          aria-describedby={describedBy(
            `${id}-password`,
            fieldError(errors, 'password'),
            PASSWORD_HINT,
          )}
        />
      </Field>

      <SubmitButton pending={create.isPending} pendingLabel="Creating your account…">
        Create account
      </SubmitButton>

      <p className="text-pretty text-xs/5 text-muted-foreground">
        By creating an account you agree to the{' '}
        <Link
          href="/legal/registration-agreement"
          className="underline underline-offset-2 hover:text-foreground"
        >
          registration agreement
        </Link>{' '}
        and the{' '}
        <Link href="/legal/privacy" className="underline underline-offset-2 hover:text-foreground">
          privacy notice
        </Link>
        .
      </p>
    </form>
  )
}
