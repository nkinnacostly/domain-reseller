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
import { signIn } from '../actions/session'

const NOTICES: Record<string, { tone: 'error' | 'success'; text: string }> = {
  confirmed: { tone: 'success', text: 'Your email is confirmed. Sign in to continue.' },
  expired: {
    tone: 'error',
    text: 'That link has expired or was already used. Sign in below, or create your account again to get a new one.',
  },
  device: {
    tone: 'error',
    text: 'That sign-in did not finish in this browser. Sign in here instead.',
  },
}

export function SignInForm({ next, notice }: { next?: string; notice?: string }) {
  const id = useId()
  const password = useAction(signIn)
  const banner = notice ? NOTICES[notice] : undefined
  const errors = password.result.validationErrors

  return (
    <div className="space-y-5">
      {banner ? <FormMessage tone={banner.tone}>{banner.text}</FormMessage> : null}
      <form
        aria-label="Sign in"
        className="space-y-4"
        noValidate
        onSubmit={onSubmitWith((form) =>
          password.execute({
            email: String(form.get('email') ?? ''),
            password: String(form.get('password') ?? ''),
            next,
          }),
        )}
      >
        {password.result.data?.error ? (
          <FormMessage tone="error">{password.result.data.error}</FormMessage>
        ) : null}
        {password.result.serverError ? (
          <FormMessage tone="error">{password.result.serverError}</FormMessage>
        ) : null}

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
          action={
            <Link
              href="/forgot-password"
              className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Forgot password?
            </Link>
          }
        >
          <PasswordInput
            id={`${id}-password`}
            name="password"
            autoComplete="current-password"
            required
            aria-invalid={fieldError(errors, 'password') ? true : undefined}
            aria-describedby={describedBy(`${id}-password`, fieldError(errors, 'password'))}
          />
        </Field>

        <SubmitButton pending={password.isPending} pendingLabel="Signing in…">
          Sign in
        </SubmitButton>
      </form>
    </div>
  )
}
