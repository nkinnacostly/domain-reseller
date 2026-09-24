'use client'

import { ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { addDomainsToCart } from '@/features/cart/actions/cart'
import { announceCartCount } from '@/features/cart/lib/count'

/**
 * "Add all available" for a bulk search (FR-S5). One button, pressed on
 * purpose: nothing is pre-ticked or added for anyone (N9). Each name is
 * re-checked before it goes in, so the answer says what was added and what
 * was not, and why.
 */
export function BulkAddAll({ domains }: { domains: readonly string[] }) {
  const add = useAction(addDomainsToCart, {
    onSuccess: ({ data }) => {
      if (data && 'count' in data) announceCartCount(data.count)
    },
  })
  const data = add.result.data
  const done = data && 'count' in data ? data : null
  const error = data && 'error' in data ? data.error : add.result.serverError

  if (done) {
    return (
      <div className="space-y-3">
        <FormMessage tone={done.added.length > 0 ? 'success' : 'error'}>
          {done.added.length > 0
            ? `Added ${done.added.length} ${done.added.length === 1 ? 'name' : 'names'} to your cart.`
            : 'Nothing could be added.'}
          {done.notAdded.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {done.notAdded.map((item) => (
                <li key={item.domain} className="break-all">
                  <span className="font-medium">{item.domain}</span> — {item.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </FormMessage>
        {done.added.length > 0 ? (
          <Link
            href="/cart"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
          >
            <ShoppingCart className="size-4" aria-hidden="true" />
            View cart
          </Link>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => add.execute({ domains: [...domains] })}
        disabled={add.isPending}
        aria-busy={add.isPending || undefined}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
      >
        {add.isPending ? (
          <Spinner className="size-4" aria-hidden="true" />
        ) : (
          <ShoppingCart className="size-4" aria-hidden="true" />
        )}
        {add.isPending
          ? 'Adding…'
          : domains.length === 1
            ? 'Add the available name to cart'
            : `Add all ${domains.length} available to cart`}
      </button>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
    </div>
  )
}
