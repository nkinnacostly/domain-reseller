'use client'

import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { Spinner } from '@/components/ui/spinner'
import { acceptCurrentPrices } from '../actions/cart'

/** FR-C4 — a changed price is never applied silently; the customer accepts it. */
export function AcceptPricesButton() {
  const router = useRouter()
  const accept = useAction(acceptCurrentPrices, { onSuccess: () => router.refresh() })
  return (
    <button
      type="button"
      onClick={() => accept.execute()}
      disabled={accept.isPending}
      className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:opacity-70"
    >
      {accept.isPending ? <Spinner className="size-4" aria-hidden="true" /> : null}
      Accept the new prices
    </button>
  )
}
