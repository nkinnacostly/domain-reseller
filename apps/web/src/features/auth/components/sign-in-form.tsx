'use client'

import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { useId, useState } from 'react'
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
import { sendMagicLink, signIn } from '../actions/session'

const NOTICES: Record<string, { tone: 'error' | 'success'; text: string }> = {
  confirmed: { tone: 'success', text: 'Your email is confirmed. Sign in to continue.' },
  expired: {
    tone: 'error',
    text: 'That link has expired or was already used. Sign in below, or ask for a new link.',
  },
  device: {
    tone: 'error',
    text: 'That link only works in the browser you asked for it from. Sign in here instead, or ask for a new link.',
  },
}

export function SignInForm({ next, notice }: { next?: string; notice?: string }) {
  const [mode, setMode] = useState<'password' | 'link'>('password')
  const id = useId()
  const password = useAction(signIn)
  const link = useAction(sendMagicLink)

  const banner = notice ? NOTICES[notice] : undefined
  const pwErrors = password.result.validationErrors
  const linkErrors = link.result.validationErrors
  const sentTo = link.result.data && 'sentTo' in link.result.data ? link.result.data.sentTo : null

  if (mode === 'link' && sentTo) {
    return (
      <div className="space-y-5">
        <FormMessage tone="success">
          If <strong className="font-medium">{sentTo}</strong> has an account, a sign-in link is on
          its way. It works once and expires in an hour.
        </FormMessage>
        <button
          type="button"
          onClick={() => {
            link.reset()
            setMode('password')
          }}
          className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign in with your password instead
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {banner ? <FormMessage tone={banner.tone}>{banner.text}</FormMessage> : null}

      {mode === 'password' ? (
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

          <Field id={`${id}-email`} label="Email" error={fieldError(pwErrors, 'email')}>
            <input
              id={`${id}-email`}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              aria-invalid={fieldError(pwErrors, 'email') ? true : undefined}
              aria-describedby={describedBy(`${id}-email`, fieldError(pwErrors, 'email'))}
              className={inputClass}
            />
          </Field>

          <Field
            id={`${id}-password`}
            label="Password"
            error={fieldError(pwErrors, 'password')}
            action={
              <Link
                href="/forgot-password"
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
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
              aria-invalid={fieldError(pwErrors, 'password') ? true : undefined}
              aria-describedby={describedBy(`${id}-password`, fieldError(pwErrors, 'password'))}
            />
          </Field>

          <SubmitButton pending={password.isPending} pendingLabel="Signing in…">
            Sign in
          </SubmitButton>
        </form>
      ) : (
        <form
          aria-label="Email me a sign-in link"
          className="space-y-4"
          noValidate
          onSubmit={onSubmitWith((form) =>
            link.execute({ email: String(form.get('email') ?? ''), next }),
          )}
        >
          {link.result.data && 'error' in link.result.data ? (
            <FormMessage tone="error">{link.result.data.error}</FormMessage>
          ) : null}
          <Field
            id={`${id}-link-email`}
            label="Email"
            error={fieldError(linkErrors, 'email')}
            hint="We'll email you a link that signs you in — no password needed."
          >
            <input
              id={`${id}-link-email`}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              aria-invalid={fieldError(linkErrors, 'email') ? true : undefined}
              aria-describedby={describedBy(
                `${id}-link-email`,
                fieldError(linkErrors, 'email'),
                "We'll email you a link",
              )}
              className={inputClass}
            />
          </Field>
          <SubmitButton pending={link.isPending} pendingLabel="Sending…">
            Email me a link
          </SubmitButton>
        </form>
      )}

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <button
        type="button"
        onClick={() => setMode(mode === 'password' ? 'link' : 'password')}
        className="inline-flex h-11 w-full items-center justify-center rounded-full border border-border bg-background px-6 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
      >
        {mode === 'password'
          ? 'Email me a sign-in link instead'
          : 'Sign in with a password instead'}
      </button>
    </div>
  )
}
