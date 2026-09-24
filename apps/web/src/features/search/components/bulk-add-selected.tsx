'use client'

import { ShoppingCart } from 'lucide-react'
import Link from 'next/link'
import { useAction } from 'next-safe-action/hooks'
import { FormMessage } from '@/components/common/form-parts'
import { Spinner } from '@/components/ui/spinner'
import { addDomainsToCart } from '@/features/cart/actions/cart'
import { announceCartCount } from '@/features/cart/lib/count'
import { MAX_CART_ITEMS } from '@/features/cart/lib/lines'

/**
 * "Add selected to cart" for a bulk search (FR-S5). Nothing is ticked for
 * anyone (N9): the person picks names, or presses "Select all available",
 * then this. Each name is re-checked with the registry before it goes in, so
 * the answer says what was added and what was not, and why. A cart holds
 * MAX_CART_ITEMS domains; past that the button says so before it is pressed.
 */
export function BulkAddSelected({
  domains,
  onAdded,
}: {
  /** ASCII domains, in the order shown. */
  domains: readonly string[]
  /** The names that went in, as the answer writes them — so the page can untick them. */
  onAdded: (added: readonly string[]) => void
}) {
  const add = useAction(addDomainsToCart, {
    onSuccess: ({ data }) => {
      if (data && 'count' in data) {
        announceCartCount(data.count)
        onAdded(data.added)
      }
    },
  })
  const data = add.result.data
  const done = data && 'count' in data ? data : null
  const error = data && 'error' in data ? data.error : add.result.serverError
  const sending = domains.slice(0, MAX_CART_ITEMS)
  const overCap = domains.length > MAX_CART_ITEMS

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <button
          type="button"
          onClick={() => add.execute({ domains: sending })}
          disabled={add.isPending || sending.length === 0}
          aria-busy={add.isPending || undefined}
          className="inline-flex h-11 w-fit items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {add.isPending ? (
            <Spinner className="size-4" aria-hidden="true" />
          ) : (
            <ShoppingCart className="size-4" aria-hidden="true" />
          )}
          {add.isPending
            ? 'Adding…'
            : sending.length === 0
              ? 'Add selected to cart'
              : overCap
                ? `Add the first ${MAX_CART_ITEMS} to cart`
                : `Add ${sending.length} to cart`}
        </button>
        {sending.length === 0 ? (
          <p className="text-pretty text-xs text-muted-foreground">
            Tick the names you want, or select all available.
          </p>
        ) : null}
      </div>

      {overCap ? (
        <p className="text-pretty text-sm text-foreground">
          A cart holds up to {MAX_CART_ITEMS} domains, so only the first {MAX_CART_ITEMS} of the{' '}
          {domains.length.toLocaleString('en-NG')} you selected can go in now. Check those out, then
          add the rest.
        </p>
      ) : null}

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {done ? (
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
      ) : null}
      {done && done.added.length > 0 ? (
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
