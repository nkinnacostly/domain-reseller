'use client'

import Link from 'next/link'
import { useState } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * A server action's outcome, shown the same way everywhere: the domain
 * settings tabs and the admin dashboard's confirm dialogs.
 */

/**
 * What went wrong, from the action's answer or the server. elevatedAction's
 * step-up message gets a link to enter a code and come back here.
 */
export function ActionError({ message, returnTo }: { message: string | null; returnTo: string }) {
  if (!message) return null
  const needsCode = message.startsWith("Confirm it's you")
  return (
    <FormMessage tone="error">
      {message}{' '}
      {needsCode ? (
        <Link
          href={`/verify?next=${encodeURIComponent(returnTo)}`}
          className="font-medium underline underline-offset-2"
        >
          Enter a code
        </Link>
      ) : null}
    </FormMessage>
  )
}

type Answer = { data?: { error: string } | object | undefined }
type Failure = { error: { serverError?: string | undefined; validationErrors?: unknown } }

/**
 * One request's outcome for a settings control: the error to show, or that
 * it was sent. Cleared as each new request starts.
 */
export function useOutcome() {
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  return {
    error,
    sent,
    callbacks: {
      onExecute: () => {
        setError(null)
        setSent(false)
      },
      onSuccess: ({ data }: Answer) => {
        if (data && 'error' in data) setError(data.error)
        else setSent(true)
      },
      // next-safe-action reports validation errors here too; the form marks
      // those beside their fields, so they are not also a failed request.
      onError: ({ error: failure }: Failure) => {
        if (failure.validationErrors && !failure.serverError) return
        setError(failure.serverError ?? 'That did not go through. Please try again.')
      },
    },
  }
}

/** A secondary button, pressed and disabled states included (S12). */
export const QUIET_BUTTON = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
  FOCUS,
)
