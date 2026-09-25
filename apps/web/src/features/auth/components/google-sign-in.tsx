'use client'

import { useAction } from 'next-safe-action/hooks'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { continueWithGoogle } from '../actions/oauth'

/**
 * "Continue with Google" (FR-A1), above the email form on sign-in and
 * sign-up. The same button does both: Google decides whether it is a new
 * account. `failed` is set when Google sent the person back without signing
 * them in (cancelled, or refused).
 */
export function GoogleSignIn({ next, failed = false }: { next?: string; failed?: boolean }) {
  const start = useAction(continueWithGoogle)
  const error =
    (start.result.data && 'error' in start.result.data ? start.result.data.error : null) ??
    start.result.serverError ??
    (failed ? 'Google sign-in did not finish. Try again, or use your email below.' : null)

  return (
    <div className="mb-5 space-y-4">
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <form
        aria-label="Continue with Google"
        onSubmit={onSubmitWith(() => start.execute({ next }))}
      >
        <SubmitButton pending={start.isPending} pendingLabel="Opening Google…" variant="secondary">
          {/* Google's own mark, in its own colours (their branding rules) — a file, not tokens. */}
          <img src="/icons/google-g.svg" alt="" width={18} height={18} className="shrink-0" />
          Continue with Google
        </SubmitButton>
      </form>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        or with your email
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
    </div>
  )
}
