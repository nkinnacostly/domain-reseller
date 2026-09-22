'use client'

import { ShieldCheck, ShieldOff } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useId } from 'react'
import { confirmTotpEnrollment, disableTwoFactor, startTotpEnrollment } from '../actions/two-factor'
import {
  describedBy,
  Field,
  FormMessage,
  fieldError,
  inputClass,
  onSubmitWith,
  SubmitButton,
} from './form-parts'

/** Groups a base32 key in fours so it can be typed without losing your place. */
function groupKey(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim()
}

export function TwoFactorPanel({ factorId }: { factorId: string | null }) {
  const id = useId()
  const router = useRouter()
  const start = useAction(startTotpEnrollment)
  const confirm = useAction(confirmTotpEnrollment, { onSuccess: () => router.refresh() })
  const disable = useAction(disableTwoFactor, {
    onSuccess: ({ data }) => {
      if (data && 'verify' in data) router.push('/verify?next=/app/settings%23two-factor')
      else if (data && 'ok' in data) router.refresh()
    },
  })

  if (factorId) {
    const error =
      disable.result.data && 'error' in disable.result.data ? disable.result.data.error : null
    return (
      <div className="space-y-4">
        <p className="flex items-start gap-2.5 text-sm/6 text-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          <span>
            <strong className="font-medium">On.</strong> Signing in needs a code from your
            authenticator app as well as your password.
          </span>
        </p>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <form action={() => disable.execute({ factorId })}>
          <SubmitButton
            pending={disable.isPending}
            pendingLabel="Turning off…"
            variant="secondary"
            className="sm:w-auto"
          >
            <ShieldOff className="size-4" aria-hidden="true" />
            Turn off two-factor
          </SubmitButton>
        </form>
      </div>
    )
  }

  const setup = start.result.data && 'factorId' in start.result.data ? start.result.data : null
  const startError =
    start.result.data && 'error' in start.result.data ? start.result.data.error : null

  if (!setup) {
    return (
      <div className="space-y-4">
        <p className="text-pretty text-sm/6 text-muted-foreground">
          <strong className="font-medium text-foreground">Off.</strong> Turn it on so that someone
          with your password — or access to your email — still can't sign in or move your domains.
        </p>
        {startError ? <FormMessage tone="error">{startError}</FormMessage> : null}
        <form onSubmit={onSubmitWith(() => start.execute())}>
          <SubmitButton pending={start.isPending} pendingLabel="Setting up…" className="sm:w-auto">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Turn on two-factor
          </SubmitButton>
        </form>
      </div>
    )
  }

  const errors = confirm.result.validationErrors
  const confirmError =
    confirm.result.data && 'error' in confirm.result.data ? confirm.result.data.error : null

  return (
    <div className="grid gap-6 md:grid-cols-[auto_1fr] md:gap-8">
      <div>
        {/* Supabase returns the QR code as an SVG data URL. */}
        {/* biome-ignore lint/performance/noImgElement: a data URL, nothing to optimise */}
        <img
          src={setup.qrCode}
          alt="QR code for adding this account to your authenticator app"
          width={176}
          height={176}
          className="rounded-xl border border-border bg-white p-2"
        />
      </div>
      <div className="min-w-0 space-y-4">
        <ol className="list-decimal space-y-2 pl-5 text-pretty text-sm/6 text-muted-foreground">
          <li>
            Open an authenticator app — Google Authenticator, Microsoft Authenticator, 1Password or
            similar — and scan the code.
          </li>
          <li>
            Can't scan? Enter this key instead:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all text-foreground">
              {groupKey(setup.secret)}
            </code>
          </li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>

        <form
          aria-label="Confirm two-factor"
          className="space-y-4"
          noValidate
          onSubmit={onSubmitWith((form) =>
            confirm.execute({ factorId: setup.factorId, code: String(form.get('code') ?? '') }),
          )}
        >
          {confirmError ? <FormMessage tone="error">{confirmError}</FormMessage> : null}
          <Field id={`${id}-code`} label="6-digit code" error={fieldError(errors, 'code')}>
            <input
              id={`${id}-code`}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              aria-invalid={fieldError(errors, 'code') ? true : undefined}
              aria-describedby={describedBy(`${id}-code`, fieldError(errors, 'code'))}
              className={`${inputClass} max-w-48 text-center tracking-[0.3em] tabular-nums`}
            />
          </Field>
          <SubmitButton pending={confirm.isPending} pendingLabel="Checking…" className="sm:w-auto">
            Confirm and turn on
          </SubmitButton>
        </form>

        <p className="text-pretty text-xs/5 text-muted-foreground">
          Keep a second way in: add this account to a second device or your password manager as
          well. If you lose every device, we can only restore access after verifying your identity,
          which takes time.
        </p>
      </div>
    </div>
  )
}
