'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { acceptCurrentPrices } from '../actions/cart'

const FAILED = 'We couldn’t update your cart. Nothing has changed — please try again.'

/** FR-C4 — a changed price is never applied silently; the customer accepts it. */
export function AcceptPricesButton() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const accept = useAction(acceptCurrentPrices, {
    onExecute: () => setError(null),
    onSuccess: ({ data }) => {
      // A refusal comes back as data, not as a thrown error: say so.
      if (data && 'error' in data) setError(data.error)
      else router.refresh()
    },
    onError: () => setError(FAILED),
  })
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => accept.execute()}
        disabled={accept.isPending}
        className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:opacity-70"
      >
        {accept.isPending ? <Spinner className="size-4" aria-hidden="true" /> : null}
        Accept the new prices
      </button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
